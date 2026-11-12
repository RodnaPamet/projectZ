import { type NextRequest } from 'next/server';

import { listMyBookings, mySummaryCounts } from '@/app-layer/usecases/my-bookings';
import { countMyUnread } from '@/app-layer/usecases/my-notifications';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toMyBookingDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/summary — the phone's «Профил» tiles and «Начало»'s next
 * booking in one call (#668): before it the home tab spent a bookings call on
 * every visit for one card, and the tiles had no numbers at all.
 *
 * Each figure comes from the use case behind the list it opens, so a tile
 * never says 3 over a list of 2: `upcomingBookings` is Резервации →
 * Предстоящи, `nextBooking` is its first row, `unreadNotifications` is the
 * bell's count.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;

  const [counts, next, unreadNotifications] = await Promise.all([
    mySummaryCounts({ userId }),
    listMyBookings({ userId, when: 'upcoming', limit: 1 }),
    countMyUnread(userId),
  ]);
  const first = next.items[0];

  return ok({
    ...counts,
    unreadNotifications,
    nextBooking: first ? toMyBookingDto(first) : null,
  });
}

export const GET = defineV1Route(handler);
