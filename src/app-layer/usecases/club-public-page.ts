import type { PrismaClient, ResourceType, SportType } from '@prisma/client';

import { mediaBaseUrl, PHOTO_SELECT, toPhotoView, type PhotoView } from '@/lib/media/photo-view';

/**
 * A club's public page, `/clubs/{slug}` (#356, Q42): who the club is and every
 * venue it runs, each linking to its own page at `/venues/{publicSlug}`.
 *
 * ═══ WHAT IS PUBLIC ═══
 *
 * The club only while it is ACTIVE: a SUSPENDED or CLOSED club's page is a 404,
 * as its venue pages are (#355) and as the sitemap leaves it out. Its venues
 * only while ACTIVE and given a public address (P41 fills it for every venue;
 * a row it missed is left out rather than linked to a 404). Courts only while
 * ACTIVE, and only what a card shows: the sport, and the price fields the
 * structured data's price range needs; and their type, which the page's title
 * names (#454).
 *
 * The fields are picked by hand. `VenueOrg` also carries Stripe and envelope
 * encryption columns; a page that read the whole row would be one refactor
 * away from rendering them.
 *
 * ═══ CROSS-TENANT, BY SLUG ═══
 *
 * The caller binds BYPASSRLS, like the venue page: a visitor has no tenant,
 * and `venue_org` and `venue` are FORCE row security. The slug is the club's
 * own unique address, so this reads exactly one club and its own venues.
 *
 * `venue.tenantId` is not a foreign key, so the venues are a second query
 * keyed on the club's id rather than an include.
 */

/** A club runs a handful of venues; this is a ceiling, not an expectation. */
export const MAX_CLUB_VENUES = 50;

export interface ClubPageVenue {
  id: string;
  publicSlug: string;
  name: string;
  addressLine: string;
  city: string;
  country: string;
  timezone: string;
  phone: string | null;
  /** Distinct, in court-name order. */
  sports: SportType[];
  /** Its courts' types, distinct: what the page's title offers to book (#454). */
  resourceTypes: ResourceType[];
  /** The venue's cover photo (#366), or null. */
  cover: PhotoView | null;
}

export interface ClubPage {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  /** The club's own number, else its main venue's. */
  phone: string | null;
  /** Oldest first: the first is the club's main venue, whose address the page shows. */
  venues: ClubPageVenue[];
  /**
   * The club page's cover (#366): the first venue's in that order that has one.
   * A club has no photo of its own; its venues do.
   */
  cover: PhotoView | null;
}

export async function loadClubPublicPage(db: PrismaClient, slug: string): Promise<ClubPage | null> {
  const club = await db.venueOrg.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, logoUrl: true, contactPhone: true, status: true },
  });
  if (!club || club.status !== 'ACTIVE') return null;

  // guardrail-allow: cross-tenant — runs BYPASSRLS for a visitor with no
  // tenant; `tenantId` scopes it to the one club the slug named.
  const rows = await db.venue.findMany({
    where: { tenantId: club.id, status: 'ACTIVE', publicSlug: { not: null } },
    select: {
      id: true,
      publicSlug: true,
      name: true,
      addressLine: true,
      city: true,
      country: true,
      timezone: true,
      phone: true,
      resources: {
        where: { status: 'ACTIVE' },
        select: { sport: true, resourceType: true },
        orderBy: { name: 'asc' },
        take: 50,
      },
      photos: { where: { kind: 'COVER' }, select: PHOTO_SELECT, take: 1 },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_CLUB_VENUES,
  });

  const base = mediaBaseUrl();
  const venues = rows.flatMap((v) =>
    v.publicSlug
      ? [
          {
            id: v.id,
            publicSlug: v.publicSlug,
            name: v.name,
            addressLine: v.addressLine,
            city: v.city,
            country: v.country,
            timezone: v.timezone,
            phone: v.phone,
            sports: [...new Set(v.resources.map((r) => r.sport))],
            resourceTypes: [...new Set(v.resources.map((r) => r.resourceType))],
            cover: v.photos[0] ? toPhotoView(v.photos[0], base) : null,
          },
        ]
      : [],
  );

  return {
    id: club.id,
    slug: club.slug,
    name: club.name,
    logoUrl: club.logoUrl,
    phone: club.contactPhone || venues[0]?.phone || null,
    venues,
    cover: venues.find((v) => v.cover)?.cover ?? null,
  };
}
