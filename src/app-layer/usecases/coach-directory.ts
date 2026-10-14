import { Prisma, type PrismaClient, type SportType } from '@prisma/client';

import { publicVenueFilter, type PublicVenueFilter } from '@/app-layer/repositories/public-venue';
import type { CoachSportInput } from '@/lib/coaches/profile';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarUrlOf } from '@/lib/media/avatar-url';

/**
 * WHAT ANYBODY ELSE MAY KNOW ABOUT A COACH (#546, and #547's public pages).
 *
 * A coach's profile is owner-only in the database (P71): a club bound as
 * itself reads none of it. This is the one place that reads it for somebody
 * else, and it gives out exactly what the platform owner approved for
 * publication:
 *
 *   an APPROVED coach   the name, the page address, the text, the
 *                       qualifications as text, the sports and levels
 *   anybody else        the name on the account, and that they are not
 *                       approved. Nothing they typed: a draft is theirs, and a
 *                       declined text was declined.
 *
 * NEVER the certificate, its name, or that one exists: that is the platform
 * owner's alone (`coach-approval.ts`, owner decision 17). And never an email
 * or a phone.
 */

export interface CoachCard {
  userId: string;
  /** The name on the account. Null for an account that is gone. */
  name: string | null;
  /** Approved by the platform owner: the rest is filled in only then. */
  approved: boolean;
  slug: string | null;
  bio: string | null;
  qualifications: string | null;
  sports: CoachSportInput[];
}

/** At most this many cards in one read; a club's list is far shorter. */
export const COACH_CARDS_MAX = 200;

/**
 * The public card of each of these accounts. An id that names nobody, or an
 * account that was deleted, has no card.
 */
export async function coachCards(userIds: readonly string[]): Promise<Map<string, CoachCard>> {
  const ids = [...new Set(userIds)].slice(0, COACH_CARDS_MAX);
  if (ids.length === 0) return new Map();

  // guardrail-allow: cross-tenant — a coach's profile belongs to a person, not
  // a club, and is owner-only under RLS; this reads the approved, public part
  // of it for the club or the player who is looking at that coach.
  return runAsSuperuser(async (db) => {
    const [users, profiles] = await Promise.all([
      db.user.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, name: true },
        take: ids.length,
      }),
      db.coachProfile.findMany({
        where: { userId: { in: ids }, status: 'APPROVED' },
        select: {
          userId: true,
          slug: true,
          bio: true,
          qualifications: true,
          sports: {
            select: { sport: true, levelMin: true, levelMax: true },
            orderBy: { sport: 'asc' },
          },
        },
        take: ids.length,
      }),
    ]);
    const approved = new Map(profiles.map((p) => [p.userId, p]));
    return new Map(
      users.map((u) => {
        const p = approved.get(u.id);
        return [
          u.id,
          {
            userId: u.id,
            name: u.name,
            approved: p !== undefined,
            slug: p?.slug ?? null,
            bio: p?.bio ?? null,
            qualifications: p?.qualifications ?? null,
            sports: p?.sports ?? [],
          },
        ];
      }),
    );
  });
}

// ═══ FINDING A COACH (#547; owner decision 10) ══════════════════════════════

/**
 * WHO IS LISTED
 *
 * A coach a player can actually book: approved by the platform, the account
 * still there, and teaching at one venue or more where everything a lesson
 * needs is set (a rate, a length, weekly hours) and the venue and its club
 * are open (`publicVenueFilter`, the same rule the venue index uses). An
 * approved coach with nowhere to teach yet has a page (their text is public)
 * that says so, and is not in any list.
 *
 * WHAT IS SHOWN
 *
 * The card above, the picture from the account (our own copy, never a
 * provider's address), and per venue the coach's rates and lengths there.
 * The page address (`slug`) is how a coach is named in public; the account id
 * is not given out. Weekly hours are not listed either: the lesson booking
 * (#548) answers "when", against the courts and the coach's other lessons.
 */

/** One venue a coach teaches at, as the public sees it. */
export interface PublicCoachVenue {
  /** The link's id: what a lesson is booked against (#548). */
  linkId: string;
  venueId: string;
  name: string;
  city: string;
  /** The venue page's address, when it has one. */
  publicSlug: string | null;
  club: { name: string; slug: string };
  hourlyRateCents: number;
  /** For two or more players. Null: no group lessons here. */
  groupRateCents: number | null;
  currency: string;
  lessonMinutes: number[];
}

export interface PublicCoach {
  slug: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  qualifications: string | null;
  sports: CoachSportInput[];
  /** Where they teach, cheapest first. Empty: approved, and teaching nowhere yet. */
  venues: PublicCoachVenue[];
  /** The lowest hourly rate among them; null with no venue. */
  fromRateCents: number | null;
  currency: string;
}

export const PUBLIC_COACHES_PAGE = 24;
export const PUBLIC_COACHES_MAX = 50;
/** Coaches listed on one venue's page. */
export const VENUE_COACHES_MAX = 50;

/** A link a lesson can be booked on, as SQL over `coach c` joined to `venue v`. */
const readyLink = (publicVenue: PublicVenueFilter) => Prisma.sql`
  c."status" = 'ACTIVE'
  AND c."hourlyRateCents" IS NOT NULL
  AND cardinality(c."lessonMinutes") > 0
  AND EXISTS (SELECT 1 FROM "coach_availability" a WHERE a."coachId" = c."id")
  AND ${publicVenue.sql('v')}`;

/** The public page of each of these accounts, by account id. Only approved coaches. */
async function loadPublic(
  db: PrismaClient,
  publicVenue: PublicVenueFilter,
  userIds: readonly string[],
): Promise<Map<string, PublicCoach>> {
  if (userIds.length === 0) return new Map();
  const ids = [...userIds];
  const [users, profiles, links] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, avatarUrl: true },
      take: ids.length,
    }),
    db.coachProfile.findMany({
      where: { userId: { in: ids }, status: 'APPROVED' },
      select: {
        userId: true,
        slug: true,
        bio: true,
        qualifications: true,
        sports: {
          select: { sport: true, levelMin: true, levelMax: true },
          orderBy: { sport: 'asc' },
        },
      },
      take: ids.length,
    }),
    // guardrail-allow: cross-tenant — a coach teaches at several clubs; these
    // are the links a lesson can be booked on, at venues the public index lists.
    db.$queryRaw<
      Array<{
        id: string;
        userId: string;
        tenantId: string;
        venueId: string;
        venueName: string;
        city: string;
        publicSlug: string | null;
        hourlyRateCents: number;
        groupRateCents: number | null;
        currency: string;
        lessonMinutes: number[];
      }>
    >`
      SELECT c."id", c."userId", c."tenantId", c."venueId", v."name" AS "venueName", v."city",
             v."publicSlug", c."hourlyRateCents", c."groupRateCents", c."currency", c."lessonMinutes"
        FROM "coach" c
        JOIN "venue" v ON v."id" = c."venueId"
       WHERE c."userId" IN (${Prisma.join(ids)})
         AND ${readyLink(publicVenue)}
       ORDER BY c."hourlyRateCents" ASC, v."name" ASC, c."id" ASC
       LIMIT ${ids.length * 20}`,
  ]);
  const clubs = await db.venueOrg.findMany({
    where: { id: { in: [...new Set(links.map((l) => l.tenantId))] } },
    select: { id: true, name: true, slug: true },
    take: Math.max(1, links.length),
  });
  const clubOf = new Map(clubs.map((c) => [c.id, c]));
  const userOf = new Map(users.map((u) => [u.id, u]));

  const out = new Map<string, PublicCoach>();
  for (const p of profiles) {
    const user = userOf.get(p.userId);
    if (!user) continue;
    const venues = links.flatMap((l): PublicCoachVenue[] => {
      const club = clubOf.get(l.tenantId);
      if (l.userId !== p.userId || !club) return [];
      return [
        {
          linkId: l.id,
          venueId: l.venueId,
          name: l.venueName,
          city: l.city,
          publicSlug: l.publicSlug,
          club: { name: club.name, slug: club.slug },
          hourlyRateCents: l.hourlyRateCents,
          groupRateCents: l.groupRateCents,
          currency: l.currency,
          lessonMinutes: l.lessonMinutes,
        },
      ];
    });
    out.set(p.userId, {
      slug: p.slug,
      name: user.name,
      avatarUrl: avatarUrlOf(user.avatarUrl),
      bio: p.bio,
      qualifications: p.qualifications,
      sports: p.sports,
      venues,
      fromRateCents: venues[0]?.hourlyRateCents ?? null,
      currency: venues[0]?.currency ?? 'EUR',
    });
  }
  return out;
}

/**
 * The coaches a player can book, by page address, optionally only those who
 * teach one sport. Keyset on the address: `cursor` is the last one of the
 * page before.
 */
export async function listPublicCoaches(
  opts: { sport?: SportType; limit?: number; cursor?: string | null } = {},
): Promise<{ items: PublicCoach[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? PUBLIC_COACHES_PAGE, PUBLIC_COACHES_MAX));
  // guardrail-allow: cross-tenant — the public list of coaches spans every
  // club by its nature, as the venue index does; approved profiles and
  // bookable links at publicly listed venues only.
  return runAsSuperuser(async (db) => {
    const publicVenue = await publicVenueFilter(db);
    const rows = await db.$queryRaw<Array<{ userId: string; slug: string }>>`
      SELECT p."userId", p."slug"
        FROM "coach_profile" p
        JOIN "app_user" u ON u."id" = p."userId" AND u."deletedAt" IS NULL
       WHERE p."status" = 'APPROVED'
         AND EXISTS (
           SELECT 1 FROM "coach" c JOIN "venue" v ON v."id" = c."venueId"
            WHERE c."userId" = p."userId" AND ${readyLink(publicVenue)})
         ${
           opts.sport
             ? Prisma.sql`AND EXISTS (SELECT 1 FROM "coach_profile_sport" s
                 WHERE s."userId" = p."userId" AND s."sport" = ${opts.sport}::"SportType")`
             : Prisma.empty
         }
         ${opts.cursor ? Prisma.sql`AND p."slug" > ${opts.cursor}` : Prisma.empty}
       ORDER BY p."slug" ASC
       LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const loaded = await loadPublic(
      db,
      publicVenue,
      page.map((r) => r.userId),
    );
    const items = page.flatMap((r) => {
      const coach = loaded.get(r.userId);
      return coach ? [coach] : [];
    });
    return { items, nextCursor: rows.length > limit ? (page.at(-1)?.slug ?? null) : null };
  });
}

/** The sports at least one listed coach teaches: what the list can be narrowed to. */
export async function publicCoachSports(): Promise<SportType[]> {
  // guardrail-allow: cross-tenant — the same public list, sports only.
  return runAsSuperuser(async (db) => {
    const publicVenue = await publicVenueFilter(db);
    const rows = await db.$queryRaw<Array<{ sport: SportType }>>`
      SELECT DISTINCT s."sport"
        FROM "coach_profile_sport" s
        JOIN "coach_profile" p ON p."userId" = s."userId" AND p."status" = 'APPROVED'
        JOIN "app_user" u ON u."id" = p."userId" AND u."deletedAt" IS NULL
       WHERE EXISTS (
           SELECT 1 FROM "coach" c JOIN "venue" v ON v."id" = c."venueId"
            WHERE c."userId" = p."userId" AND ${readyLink(publicVenue)})
       ORDER BY s."sport" ASC
       LIMIT 64`;
    return rows.map((r) => r.sport);
  });
}

/** One approved coach by their page address; null for anybody else. */
export async function publicCoachBySlug(slug: string): Promise<PublicCoach | null> {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return null;
  // guardrail-allow: cross-tenant — one approved coach's public page, by its
  // address; the profile is a person's, and the venues are the public index's.
  return runAsSuperuser(async (db) => {
    const profile = await db.coachProfile.findFirst({
      where: { slug, status: 'APPROVED' },
      select: { userId: true },
    });
    if (!profile) return null;
    const loaded = await loadPublic(db, await publicVenueFilter(db), [profile.userId]);
    return loaded.get(profile.userId) ?? null;
  });
}

/** The coaches a player can book at one venue, with the rate there first. */
export async function coachesAtVenue(venueId: string): Promise<PublicCoach[]> {
  // guardrail-allow: cross-tenant — the venue page is public; these are the
  // approved coaches with a bookable link at that one venue.
  return runAsSuperuser(async (db) => {
    const publicVenue = await publicVenueFilter(db);
    const rows = await db.$queryRaw<Array<{ userId: string }>>`
      SELECT c."userId"
        FROM "coach" c
        JOIN "venue" v ON v."id" = c."venueId"
        JOIN "coach_profile" p ON p."userId" = c."userId" AND p."status" = 'APPROVED'
        JOIN "app_user" u ON u."id" = c."userId" AND u."deletedAt" IS NULL
       WHERE c."venueId" = ${venueId}
         AND ${readyLink(publicVenue)}
       ORDER BY p."slug" ASC
       LIMIT ${VENUE_COACHES_MAX}`;
    const loaded = await loadPublic(
      db,
      publicVenue,
      rows.map((r) => r.userId),
    );
    return rows.flatMap((r) => {
      const coach = loaded.get(r.userId);
      if (!coach) return [];
      // This venue first: its rate is the one this page is about.
      const here = coach.venues.filter((v) => v.venueId === venueId);
      const elsewhere = coach.venues.filter((v) => v.venueId !== venueId);
      return [{ ...coach, venues: [...here, ...elsewhere] }];
    });
  });
}

/** Every listed coach's page address and when it last changed, for the sitemap. */
export async function listSitemapCoaches(
  limit: number,
): Promise<Array<{ slug: string; updatedAt: Date }>> {
  // guardrail-allow: cross-tenant — the same public list, addresses only.
  return runAsSuperuser(async (db) => {
    const publicVenue = await publicVenueFilter(db);
    return db.$queryRaw<Array<{ slug: string; updatedAt: Date }>>`
      SELECT p."slug", p."updatedAt"
        FROM "coach_profile" p
        JOIN "app_user" u ON u."id" = p."userId" AND u."deletedAt" IS NULL
       WHERE p."status" = 'APPROVED'
         AND EXISTS (
           SELECT 1 FROM "coach" c JOIN "venue" v ON v."id" = c."venueId"
            WHERE c."userId" = p."userId" AND ${readyLink(publicVenue)})
       ORDER BY p."slug" ASC
       LIMIT ${limit}`;
  });
}
