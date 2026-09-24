import { type NextRequest, NextResponse } from 'next/server';

import { ok } from '@/app/api/v1/_lib/envelope';
import {
  mintAccessToken,
  NATIVE_SESSION_TTL_SECONDS,
  rfc3339,
  type NativeTokens,
} from '@/app/api/v1/_lib/native-token';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { createUserSession, newSessionSecret, setRefreshToken } from '@/lib/auth/sessions';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { checkRateLimit, LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { getClientIp } from '@/lib/security/rate-limit-middleware';

/**
 * POST /api/v1/auth/token — sign in from a native client.
 *
 * ═══ THE THROTTLE IS THE FIRST THING, AND SHARES THE WEB'S BUDGET ═══
 *
 * This is the SECOND password endpoint in the app. #95 wired LOGIN_LIMIT to
 * POST /api/auth/callback/credentials, keyed `login:<ip>`.
 *
 * If this endpoint used its own key, or leaned on the wrapper's default, it
 * would be a way around that limiter — the mutation default is 60/min against
 * LOGIN_LIMIT's 10 per 15 minutes, roughly ninety times the budget, reachable
 * by pointing the same script at a different URL.
 *
 * So it uses the SAME key. Attempts against either endpoint draw down one
 * shared allowance, which is the only reading of "ten attempts" that means
 * anything.
 *
 * ═══ WHY IT DOES NOT CALL authorize() ═══
 *
 * It cannot. next-auth's CredentialsProvider returns an object whose top-level
 * `authorize` is a stub returning null synchronously; the real one is nested
 * under `.options`. The declared type says otherwise, so calling it compiles
 * and rejects every correct password in silence.
 *
 * `verifyCredentials` is the shared implementation both paths use, which also
 * keeps the equal-bcrypt-time enumeration defence in one place.
 */
async function handler(req: NextRequest) {
  const ip = getClientIp(req);

  // Before reading the body: an attacker should not get to spend our parsing
  // or our bcrypt on attempt eleven.
  const limit = checkRateLimit(`login:${ip}`, LOGIN_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } },
      { status: 429, headers: { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;

  const user = await verifyCredentials(body?.email, body?.password);

  if (!user) {
    // ONE message, and it says nothing about which half was wrong. The timing
    // defence in verifyCredentials is worthless if the response distinguishes
    // "no such account" from "wrong password".
    return NextResponse.json(
      { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } },
      { status: 401 },
    );
  }

  const now = Date.now();
  const sessionSecret = newSessionSecret();
  const refreshToken = newSessionSecret();

  const {
    userSessionId,
    sessionVersion,
    expiresAt: sessionExpiresAt,
  } = await createUserSession({
    userId: user.id,
    tenantId: null,
    sessionSecret,
    // The ROW lives as long as the refresh window, not the access token. A row
    // that died with the access token would revoke a refresh token the client
    // still legitimately holds.
    expiresAt: new Date(now + NATIVE_SESSION_TTL_SECONDS * 1000),
    ipAddress: ip,
    // So a session list can name the device. The web path leaves both null.
    userAgent: req.headers.get('user-agent'),
  });

  await setRefreshToken(userSessionId, refreshToken);

  const { accessToken, expiresAt } = await mintAccessToken({
    sub: user.id,
    userSessionId,
    sessionVersion,
  });

  return ok<NativeTokens>({
    tokenType: 'Bearer',
    accessToken,
    expiresAt: rfc3339(expiresAt),
    expiresIn: Math.floor((expiresAt.getTime() - now) / 1000),
    refreshToken,
    // The ROW's expiry, as stored — not a window measured from this response.
    // `rotateRefreshToken` rejects against that column and nothing ever writes
    // it again, so this is the only value that stays true as the session is
    // refreshed. /auth/refresh returns the same column for the same reason.
    refreshExpiresAt: rfc3339(sessionExpiresAt),
  });
}

export const POST = defineV1Route(handler);
