import { type NextRequest } from 'next/server';

import { notifyCoachLinkRequested } from '@/app-layer/usecases/coach-link-notifications';
import { myCoachLinks, requestToTeach } from '@/app-layer/usecases/coach-links';
import { toMyCoachLinks } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET  /api/v1/me/coach-links   the venues the caller teaches at, or asked to
 * POST /api/v1/me/coach-links   ask to teach at a venue: { venueId }
 *
 * A coach and a club's venue (#546; owner decision 4). A link is one coach at
 * one venue: `REQUESTED` until the club's owner or manager answers, then
 * `ACTIVE` or `DECLINED`; `ENDED` once either side ends it.
 *
 * For COACH accounts (403 `COACH_ACCOUNT_REQUIRED`). The list is the coach's
 * own, across every club, newest first, each with the club, the venue, the
 * terms the coach set there (rates, lengths, cancellation cutoff, weekly
 * hours), the lengths the venue's courts allow (`lengthOptions`), and what an
 * active link still needs before a lesson can be booked on it (`missing`).
 * `approved` says whether the platform approved the coach's profile.
 *
 * Asking needs that approval: 403 `COACH_NOT_APPROVED` without it. The venue
 * must be listed and its club open (404 `VENUE_NOT_FOUND`). A link that is
 * waiting or running is 409 `COACH_LINK_EXISTS` with `details.status`; one
 * that was declined or ended can be asked for again and starts over. A person
 * the club suspended is 403 `COACH_SUSPENDED_AT_CLUB`.
 *
 * Both answer with the whole list, so a client replaces what it shows.
 */
async function getHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ok(toMyCoachLinks(await myCoachLinks(ctx.userId)));
}

async function postHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = (await req.json().catch(() => null)) as { venueId?: unknown } | null;
  const venueId = body?.venueId;
  if (typeof venueId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(venueId)) {
    throw new ValidationError('`venueId` is required', { field: 'venueId' });
  }
  const made = await requestToTeach(ctx.userId, venueId);
  // The club's owners and managers hear of it (#550), after it committed.
  await notifyCoachLinkRequested({ ...made, at: new Date() });
  return ok(toMyCoachLinks(await myCoachLinks(ctx.userId)), { status: 201 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
