import { type NextRequest } from 'next/server';

import { myFavouriteVenues } from '@/app-layer/usecases/favourites';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/favourites/venues — the caller's favourite clubs (#672):
 * `ids` for the hearts on any list, `items` (venue cards, newest heart first)
 * for «Любими». One list, at most 200, so not paged.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ok(await myFavouriteVenues(ctx.userId));
}

export const GET = defineV1Route(handler);
