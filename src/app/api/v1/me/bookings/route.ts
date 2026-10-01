import { type NextRequest } from 'next/server';

import { listMyBookings } from '@/app-layer/usecases/my-bookings';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toMyBookingDto } from '@/app/api/v1/_lib/dto';
import { page } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/bookings — the caller's own bookings, at every club.
 *
 * `GET /t/{slug}/bookings` lists one club's; a player with bookings at three
 * clubs would need three calls and a list of their clubs — which a native
 * token does not carry. This is the list `/me/bookings` renders, through the
 * same use case, so the app and the page cannot disagree about what is yours.
 *
 * ═══ THE BINDING IS THE USE CASE'S ═══
 *
 * `listMyBookings` binds BYPASSRLS itself, scoped to `bookedByUserId` — see
 * the header of `usecases/my-bookings` for why no narrower binding returns
 * any rows. The only inputs it takes from this request are the cursor and the
 * limit; the user id is the session's.
 *
 * Paging is the repository's keyset: newest `startTs` first, the cursor is
 * the last booking's id, and `limit` is clamped to 1..100 (default 20) rather
 * than refused.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const sp = req.nextUrl.searchParams;

  const { items, nextCursor } = await listMyBookings({
    userId: ctx.userId,
    cursor: sp.get('cursor') || null,
    // `limit=abc` is NaN and `limit=` is 0; `clampBookingLimit` turns both
    // into the default (`!requested`), so neither needs refusing here.
    limit: sp.has('limit') ? Number(sp.get('limit')) : undefined,
  });

  return page(
    items.flatMap((b) => (b ? [toMyBookingDto(b)] : [])),
    nextCursor,
  );
}

export const GET = defineV1Route(handler);
