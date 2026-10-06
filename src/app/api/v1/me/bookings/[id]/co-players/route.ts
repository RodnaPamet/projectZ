import { type NextRequest } from 'next/server';

import { listCoPlayers } from '@/app-layer/usecases/booking-players';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import type { CoPlayerDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/bookings/{id}/co-players — people the booker has played
 * with, most recent first, who are not on this booking yet (#358, Q29): the
 * "add from players you know" list. At most 20, PLAYER accounts only, names
 * and avatars. The booker's; 403 BOOKER_ONLY for an added player.
 *
 * Not paginated: `{"data": [ … ]}`.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const people = await listCoPlayers({ userId: ctx.userId, bookingId: id });
  return ok(
    people.map((p): CoPlayerDto => ({ userId: p.userId, name: p.name, avatarUrl: p.avatarUrl })),
  );
}

export const GET = defineV1Route(handler);
