import type { PrismaClient, SportType } from '@prisma/client';

import { publicVenueFilter } from '@/app-layer/repositories/public-venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { canonicalCity } from '@/lib/geo/cities';
import { mediaBaseUrl, PHOTO_SELECT, toPhotoView, type PhotoView } from '@/lib/media/photo-view';

/**
 * The clubs the landing page shows (#369): the pilot clubs, read LIVE.
 *
 * A club is shown when it is ACTIVE and has at least one venue the public can
 * open: `publicVenueFilter` (the venue ACTIVE, its club ACTIVE, #298/#422) and
 * a public address (`publicSlug`), the same set the sitemap and the club pages
 * list. Until a real club is onboarded the list is empty and the page says so
 * in its own words; nothing is ever invented to fill it.
 *
 * Each club carries what a card needs and no more: its name and page, the
 * cities and sports of its live venues, and a cover photo (#366) from the
 * first of them that has one. The fields are picked by hand, as on the club
 * page: `venue_org` also holds Stripe and encryption columns.
 *
 * ═══ CROSS-TENANT, AND WHY THAT IS SAFE ═══
 *
 * A visitor has no club, and `venue` / `venue_org` are FORCE row security, so
 * this binds BYPASSRLS as /venues does. What keeps it public is the filter
 * above and the hand-picked fields, not the tenant policy.
 */

/** The most clubs the page shows. A pilot has a handful. */
export const PILOT_CLUBS_MAX = 6;

/** Live venues read to find them: a ceiling, ordered oldest first. */
const VENUES_SCANNED = 60;

export interface PilotClub {
  id: string;
  slug: string;
  name: string;
  /** Canonical spellings, as `?city=` carries them; label with `cityLabel`. */
  cities: string[];
  sports: SportType[];
  venueCount: number;
  cover: PhotoView | null;
}

export async function listPilotClubs(
  db: PrismaClient,
  limit: number = PILOT_CLUBS_MAX,
): Promise<PilotClub[]> {
  const publicVenue = await publicVenueFilter(db);
  // guardrail-allow: cross-tenant — the landing page's pilot clubs span every
  // club, as /venues does; `publicVenue.where` keeps it to public venues.
  const venues = await db.venue.findMany({
    where: { AND: [{ publicSlug: { not: null } }, publicVenue.where] },
    select: {
      tenantId: true,
      city: true,
      resources: {
        where: { status: 'ACTIVE' },
        select: { sport: true },
        orderBy: { name: 'asc' },
        take: 50,
      },
      photos: { where: { kind: 'COVER' }, select: PHOTO_SELECT, take: 1 },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: VENUES_SCANNED,
  });
  if (venues.length === 0) return [];

  const clubIds = [...new Set(venues.map((v) => v.tenantId))];
  // guardrail-allow: cross-tenant — the clubs of the public venues just read;
  // ACTIVE only, and only the name and slug.
  const clubs = await db.venueOrg.findMany({
    where: { id: { in: clubIds }, status: 'ACTIVE' },
    select: { id: true, slug: true, name: true },
    take: clubIds.length,
  });
  const clubById = new Map(clubs.map((c) => [c.id, c]));

  const base = mediaBaseUrl();
  const out = new Map<string, PilotClub>();
  // Oldest venue first, so the pilot's first clubs lead.
  for (const v of venues) {
    const club = clubById.get(v.tenantId);
    // `venue.tenantId` is not a foreign key: a venue whose club row is gone
    // has no page to link to, so it is left out.
    if (!club) continue;
    const entry =
      out.get(club.id) ??
      ({
        id: club.id,
        slug: club.slug,
        name: club.name,
        cities: [],
        sports: [],
        venueCount: 0,
        cover: null,
      } satisfies PilotClub);
    entry.venueCount += 1;
    const city = canonicalCity(v.city);
    if (city && !entry.cities.includes(city)) entry.cities.push(city);
    for (const r of v.resources) if (!entry.sports.includes(r.sport)) entry.sports.push(r.sport);
    if (!entry.cover && v.photos[0]) entry.cover = toPhotoView(v.photos[0], base);
    out.set(club.id, entry);
  }

  return [...out.values()].slice(0, limit);
}

/**
 * The landing page's read, bound. It throws like any read; the page catches
 * it and shows the "clubs are coming" copy, so the shop window renders
 * whatever the database is doing.
 */
export async function loadPilotClubs(): Promise<PilotClub[]> {
  return runAsSuperuser((db) => listPilotClubs(db));
}
