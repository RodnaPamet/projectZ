import { type NextRequest } from 'next/server';

import {
  FavouriteVenueNotFoundError,
  setFavouriteVenue,
  TooManyFavouritesError,
} from '@/app-layer/usecases/favourites';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * PUT / DELETE /api/v1/me/favourites/venues/{venueId} — the heart on and off
 * (#672). Both idempotent: a second PUT or DELETE answers the same.
 */
function handler(favourite: boolean) {
  return async (req: NextRequest, { params }: { params: Promise<{ venueId: string }> }) => {
    const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
    if (!ctx.userId) throw new UnauthorizedError('Authentication required');
    const { venueId } = await params;
    try {
      return ok(await setFavouriteVenue({ userId: ctx.userId, venueId, favourite }));
    } catch (err) {
      if (err instanceof FavouriteVenueNotFoundError) throw new NotFoundError('Venue not found');
      if (err instanceof TooManyFavouritesError) throw new ConflictError(err.message);
      throw err;
    }
  };
}

export const PUT = defineV1Route(handler(true));
export const DELETE = defineV1Route(handler(false));
