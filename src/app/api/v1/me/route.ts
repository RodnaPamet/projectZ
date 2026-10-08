import { getToken } from 'next-auth/jwt';
import { type NextRequest } from 'next/server';

import { updateMeBodySchema } from '@/app-layer/schemas/me';
import { deleteMyAccount } from '@/app-layer/usecases/account-deletion';
import { getMe } from '@/app-layer/usecases/me';
import { updateMyProfile } from '@/app-layer/usecases/my-profile';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent, ok } from '@/app/api/v1/_lib/envelope';
import { expireSessionCookies } from '@/lib/auth/session-cookies';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { logger } from '@/lib/observability/logger';
import { ACCOUNT_DELETE_LIMIT } from '@/lib/security/rate-limit';

/**
 * GET /api/v1/me — who am I, and what kind of account is this?
 *
 * The club-free twin of `GET /t/{slug}/me`. That one answers "what am I at
 * THIS club"; this one answers what a client must know before it has a club
 * to ask about: the account's kind (#263) and why it lands where it does, so
 * the iOS app can open on the right screen after sign-in instead of guessing
 * from the bookings it happens to find.
 *
 * No web paths in the answer — see `usecases/me` for why the reason travels
 * and the href does not.
 *
 * Not public, and not in the permission table: it addresses no club, so there
 * is no permission to hold, only a session. The edge lets it through (no slug
 * in the path) and this refuses an anonymous caller itself.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const me = await getMe(ctx.userId);

  // A live session over an account row that is gone. `checkSession` makes this
  // unreachable today — it reads the account's session version — and if it is
  // ever reached, "not signed in" is the true answer, not a 404 about a
  // resource.
  if (!me) throw new UnauthorizedError('Authentication required');

  return ok(me);
}

/**
 * PATCH /api/v1/me — set the display name, and the sports played with a
 * self-declared level 1–7 for each (#359). Answers the whole account, as
 * GET does, so a client replaces its copy rather than merging.
 *
 * The body is `updateMeBodySchema`: `.strict()`, so `email`, `accountKind`,
 * `locale` or anything else is a 400 naming the field, never silently
 * ignored and never written. The user id is the session's; there is no id in
 * the path or the body to point it at another account.
 *
 * A CLUB account may set its name and is refused sports (403
 * PLAYER_ACCOUNT_REQUIRED): it does not play (#263).
 */
async function patchHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const raw: unknown = await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  });

  const parsed = updateMeBodySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    // The top-level property at fault. An unknown key at the top names itself
    // (zod puts it in `keys`, with an empty `path`); anywhere deeper, the
    // field it sits in does (`sports`).
    const field = first?.path.length
      ? String(first.path[0])
      : first?.code === 'unrecognized_keys'
        ? first.keys[0]
        : undefined;
    throw new ValidationError('Invalid profile', {
      ...(field ? { field } : {}),
      issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
    });
  }

  const updated = await updateMyProfile(ctx.userId, parsed.data);
  if (!updated) throw new UnauthorizedError('Authentication required');

  const me = await getMe(ctx.userId);
  if (!me) throw new UnauthorizedError('Authentication required');
  return ok(me);
}

/**
 * DELETE /api/v1/me — delete my account, at once and for good (#370).
 *
 * The rules are the use case's, checked inside its transaction under a lock
 * on the account, never taken from the client: 403
 * `CLUB_ACCOUNT_DELETION_BY_REQUEST` for a club account (it asks through the
 * contact form, owner decision 3), 409 `UPCOMING_BOOKINGS` while the person
 * has a booking still to play, with the bookings in `details`. Nothing is
 * changed by a refusal.
 *
 * 204 on success. Every session of the account is gone by then (its rows are
 * deleted, so `checkSession` signs out every token on its next request), and
 * this response also expires the session cookie it came with, so the browser
 * that asked is signed out without waiting for that.
 *
 * Rate-limited per (IP, account) at ACCOUNT_DELETE_LIMIT: 5 an hour.
 */
async function deleteHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const summary = await deleteMyAccount(ctx.userId);
  // Counts by table, no ids: the operator's trail of what one deletion did.
  logger.info('account deleted by its holder', { component: 'account', rows: summary });

  return expireSessionCookies(noContent(), req);
}

export const GET = defineV1Route(handler);
export const PATCH = defineV1Route(patchHandler);
export const DELETE = defineV1Route(deleteHandler, {
  rateLimit: {
    config: ACCOUNT_DELETE_LIMIT,
    scope: 'account-delete',
    // Keyed on the account as well as the IP, so people deleting at one club's
    // wifi do not share a budget. Read from the token alone; the handler
    // checks the session.
    getUserId: async (req) => (await getToken({ req, secret: process.env.NEXTAUTH_SECRET }))?.sub,
  },
});
