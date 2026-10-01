import { type NextRequest } from 'next/server';

import { getMe } from '@/app-layer/usecases/me';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

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

export const GET = defineV1Route(handler);
