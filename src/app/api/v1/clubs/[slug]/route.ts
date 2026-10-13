import { type NextRequest } from 'next/server';

import { loadClubPublicPage } from '@/app-layer/usecases/club-public-page';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toClubPublicDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/clubs/{slug} — a club's public page (#411), for the native app:
 * what /clubs/{slug} shows on the web, from the same loader.
 *
 * The club's name, logo and phone, and its venues (oldest first, the first is
 * the main one) with their address, sports, court types and cover. Each
 * venue's free times are `GET /venues/{id}/availability`, as on the web.
 *
 * Public, BYPASSRLS like the venue reads: a visitor has no tenant to bind, and
 * `loadClubPublicPage` reads only public fields, of an ACTIVE club, scoped to
 * the one club the slug names. A suspended or closed club is a 404,
 * indistinguishable from none.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  const club = await asSuperuser(ctx, (db) => loadClubPublicPage(db, slug));
  if (!club) throw new NotFoundError('Club not found');

  return ok(toClubPublicDto(club));
}

export const GET = defineV1Route(handler);
