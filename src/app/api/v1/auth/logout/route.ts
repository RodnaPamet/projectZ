import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent } from '@/app/api/v1/_lib/envelope';
import { revokeAllSessions, revokeSession } from '@/lib/auth/sessions';
import { getRequestId } from '@/lib/observability/context';
import { getToken } from 'next-auth/jwt';

/**
 * POST /api/v1/auth/logout — end this session, or all of them.
 *
 * Body: `{ "everywhere": true }` to revoke every session for the user.
 *
 * ═══ WHY THE DEFAULT IS THIS DEVICE ONLY ═══
 *
 * "Log out" on a phone means this phone. A user signing out of a borrowed
 * iPad does not expect their own phone to be signed out too, and a logout that
 * silently did that would be reported as a bug — or worse, not reported, and
 * quietly train people not to log out.
 *
 * `everywhere` is the deliberate version. It bumps User.sessionVersion, which
 * reaches tokens we have never seen: devices that are offline, tokens minted
 * by instances that have since died. That is the one to use after a password
 * change or a suspected compromise.
 *
 * ═══ ALWAYS 204 ═══
 *
 * Logging out twice, or with a token that was already revoked, is not an
 * error — the caller's intent is satisfied either way, and the state they
 * wanted is the state they get. Returning 401 for "your token was already
 * dead" invites a client to treat logout as something that can fail and
 * retry, which is how a sign-out button ends up spinning forever.
 *
 * This runs through `contextFromRequest`, so a token whose session is already
 * revoked arrives as anonymous and falls out at the `userId` check below.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  const body = (await req.json().catch(() => null)) as { everywhere?: boolean } | null;

  if (!ctx.userId) {
    // Anonymous, or a session that is already dead. Nothing to do, and saying
    // so would leak whether the token was ever real.
    return noContent();
  }

  if (body?.everywhere) {
    await revokeAllSessions(ctx.userId);
    return noContent();
  }

  // The session id is not on RequestContext — it is a claim, and this is the
  // one endpoint that needs it. Read it from the token rather than widening
  // RequestContext for a single caller.
  const raw = (await getToken({ req, secret: process.env.NEXTAUTH_SECRET })) as {
    userSessionId?: string | null;
  } | null;

  if (raw?.userSessionId) await revokeSession(raw.userSessionId);

  return noContent();
}

export const POST = defineV1Route(handler);
