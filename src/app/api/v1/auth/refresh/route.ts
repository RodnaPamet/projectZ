import { type NextRequest, NextResponse } from 'next/server';

import { ok } from '@/app/api/v1/_lib/envelope';
import { mintAccessToken, rfc3339, type NativeTokens } from '@/app/api/v1/_lib/native-token';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rotateRefreshToken } from '@/lib/auth/sessions';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * POST /api/v1/auth/refresh — trade a refresh token for a new access token.
 *
 * ═══ THE FAILURE THIS IS SHAPED AROUND IS NOT THEFT ═══
 *
 * It is a legitimate user being logged out. An iOS app resumed from the app
 * switcher fires several requests at once; they all 401 on an expired access
 * token and all arrive here with the SAME refresh token within milliseconds.
 *
 * Strict rotation calls the second one a replay and kills the session. The
 * user is signed out for using their phone normally — and it does not
 * reproduce on a desk, where requests happen one at a time.
 *
 * `rotateRefreshToken` handles that with a grace window and a compare-and-swap;
 * the endpoint's job is to translate its outcome into something a client can
 * act on without guessing.
 *
 * ═══ TWO KINDS OF NO ═══
 *
 * `replayed` is deliberately NOT distinguished from `revoked` in the response.
 * A client cannot do anything different about it, and telling an attacker
 * "that token was already used" confirms they hold a real one.
 */
async function handler(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { refreshToken?: string } | null;
  const presented = body?.refreshToken;

  if (!presented) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'refreshToken is required.' } },
      { status: 400 },
    );
  }

  const outcome = await rotateRefreshToken({ presented });

  if (!outcome.ok) {
    // 401 across the board: every one of these means "sign in again", and a
    // client that has to branch on the reason will get the branch wrong.
    return NextResponse.json(
      { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Sign in again.' } },
      { status: 401 },
    );
  }

  // The access token's secret is NOT rotated — `tokenHash` binds every access
  // token for this session, and rotating it here would invalidate the ones
  // already in flight. That is the logout cannon, from the other end.
  const session = await runAsSuperuser((db) =>
    db.userSession.findUniqueOrThrow({
      where: { id: outcome.userSessionId },
      // `expiresAt` is not checked here — it is the refresh deadline the
      // response advertises. See `refreshExpiresAt` below.
      select: { sessionVersion: true, expiresAt: true },
    }),
  );

  const { accessToken, expiresAt } = await mintAccessToken({
    sub: outcome.userId,
    userSessionId: outcome.userSessionId,
    sessionVersion: session.sessionVersion,
  });

  const now = Date.now();

  return ok<NativeTokens>({
    tokenType: 'Bearer',
    accessToken,
    expiresAt: rfc3339(expiresAt),
    expiresIn: Math.floor((expiresAt.getTime() - now) / 1000),
    // Null inside the grace window: "keep the token you already have". Not an
    // empty string — a falsy-but-present value is what ends up in a keychain.
    refreshToken: outcome.refreshToken,
    // ═══ THE ROW'S DEADLINE, NOT now + 30 DAYS ═══
    //
    // This used to be recomputed as now + REFRESH_TOKEN_TTL_SECONDS on every
    // response, including the ones that rotated nothing. The deadline the
    // server ENFORCES is `user_session.expiresAt` — `rotateRefreshToken`
    // rejects against that column, and nothing anywhere writes it after the
    // row is created. So the advertised value slid forward on every call while
    // the real one stood still, and a client refreshing daily would read a
    // session that never ends and be signed out without warning on day 30.
    //
    // Rotation does NOT extend it: the rotating update writes the token
    // hashes, the grace deadline and `lastSeenAt`, and leaves `expiresAt`
    // alone. The refresh window is an ABSOLUTE 30 days from sign-in.
    refreshExpiresAt: rfc3339(session.expiresAt),
  });
}

export const POST = defineV1Route(handler);
