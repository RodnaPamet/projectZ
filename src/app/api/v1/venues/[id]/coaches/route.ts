import { type NextRequest } from 'next/server';

import { coachesAtVenue } from '@/app-layer/usecases/coach-directory';
import { toPublicCoach } from '@/app/api/v1/_lib/coach-dto';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ValidationError } from '@/lib/errors/types';

/**
 * GET /api/v1/venues/{id}/coaches
 *
 * The coaches a player can book at one venue (#547; owner decision 10).
 * Public: no sign-in.
 *
 * The same coaches and the same shape as `GET /coaches`, kept to those with a
 * bookable link at this venue, by page address. In each one's `venues`, this
 * venue comes first, so `venues[0]` holds the rates here; the others follow.
 *
 * A venue that does not exist, is closed, or belongs to a club that is not
 * open has no coaches to list: the answer is an empty `items`, as for a venue
 * where nobody teaches. Up to 50.
 */
async function handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    throw new ValidationError('That is not a venue id', { field: 'id' });
  }
  const coaches = await coachesAtVenue(id);
  return ok({ items: coaches.map(toPublicCoach) });
}

export const GET = defineV1Route(handler);
