import { Prisma, type CoachLinkStatus, type PrismaClient } from '@prisma/client';

import { coachCards, type CoachCard } from '@/app-layer/usecases/coach-directory';
import { CoachAccountRequiredError } from '@/app-layer/usecases/coach-profile';
import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { publicVenueFilter } from '@/app-layer/repositories/public-venue';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import {
  formatClock,
  lessonLengthOptions,
  missingForLessons,
  readTeachingHours,
  readTeachingTerms,
  type TeachingMissing,
} from '@/lib/coaches/teaching';
import { runAsSuperuser, runAsUserOnly, runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * A COACH AND A CLUB'S VENUE (#546, #377; owner decisions 2, 4, 5, 6, 9, 14).
 *
 * A `coach` row is one coach teaching at one venue: who asked whom, whether
 * the other side agreed, and the coach's terms there (an hourly rate, a group
 * rate, the lengths taught, how late a player may cancel, weekly hours).
 *
 *   REQUESTED ──club accepts──▶ ACTIVE ──either side ends──▶ ENDED
 *       │  └──club declines──▶ DECLINED         (asking again starts over)
 *       └──coach takes it back──▶ ENDED
 *
 *   (a club's email invitation, accepted, makes ACTIVE links directly:
 *    `linkInvitedCoach`, called by `acceptInvite`)
 *
 * ═══ TWO SIDES, TWO HANDLES ═══
 *
 * The rows are the CLUB's (tenant-scoped, P05/P71). The club's functions take
 * a handle bound to the club, as every admin use case does.
 *
 * The coach is nothing at the club until it accepts, so the coach's functions
 * cannot be handed one. Each does ONE unscoped read first, to learn which club
 * the thing it was asked about belongs to (a venue by its id, or one of the
 * coach's own links by its id AND the coach's account), and then does all of
 * its work bound to that club, under the same row security as the club's own
 * code. `myCoachLinks`, which by its nature spans the clubs a coach teaches
 * at, is the one read that stays unscoped, and it is keyed on the account.
 *
 * ═══ THE MEMBERSHIP FOLLOWS THE LINKS ═══
 *
 * A coach with an ACTIVE link at a club is a member of it with the role
 * COACH, as a club's email invitation has always made them; one with none is
 * a PLAYER there if they are anything (a coach plays too, #377). One rule,
 * applied after every change of a link: `syncCoachMembership`. The staff
 * screen shows the role and does not change it.
 *
 * ═══ WHAT ENDING DOES NOT DO ═══
 *
 * Ending a link stops new lessons. Lessons already booked stay until they are
 * cancelled (#549 owns that); the link row stays, because they point at it.
 */

// ─── Errors ────────────────────────────────────────────────────────────────

/** Asking a club to teach needs the platform's approval first (decision 13). */
export class CoachNotApprovedError extends Error {
  constructor() {
    super('Your coach profile has to be approved before you ask a club.');
    this.name = 'CoachNotApprovedError';
  }
}

/** No such venue, or it is not open for business. */
export class CoachVenueNotFoundError extends Error {
  constructor() {
    super('No such venue.');
    this.name = 'CoachVenueNotFoundError';
  }
}

/** The coach and this venue already have something going: a request, or a link. */
export class CoachLinkExistsError extends Error {
  constructor(readonly status: CoachLinkStatus) {
    super(`There is already a ${status} link between this coach and this venue.`);
    this.name = 'CoachLinkExistsError';
  }
}

export class CoachLinkNotFoundError extends Error {
  constructor() {
    super('No such link between a coach and a venue.');
    this.name = 'CoachLinkNotFoundError';
  }
}

/** The link is not in a state this can be done to. */
export class CoachLinkStateError extends Error {
  constructor(readonly status: CoachLinkStatus) {
    super(`That cannot be done to a ${status} link.`);
    this.name = 'CoachLinkStateError';
  }
}

/** The club suspended this person; it lifts that before it takes them as a coach. */
export class CoachSuspendedAtClubError extends Error {
  constructor() {
    super('This account is suspended at the club.');
    this.name = 'CoachSuspendedAtClubError';
  }
}

// ─── Shapes ────────────────────────────────────────────────────────────────

const LIVE: readonly CoachLinkStatus[] = ['REQUESTED', 'INVITED', 'ACTIVE'];

export interface TeachingHoursView {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** `HH:MM`, in the venue's time. */
  open: string;
  close: string;
}

interface Terms {
  hourlyRateCents: number | null;
  groupRateCents: number | null;
  currency: string;
  lessonMinutes: number[];
  cancelCutoffHours: number;
  hours: TeachingHoursView[];
}

/** One of the coach's own links, as the coach sees it. */
export interface MyCoachLink extends Terms {
  id: string;
  status: CoachLinkStatus;
  startedBy: 'COACH' | 'CLUB';
  club: { name: string; slug: string };
  venue: { id: string; name: string; city: string; timezone: string };
  /** The lengths this venue's courts are booked for: what `lessonMinutes` is chosen from. */
  lengthOptions: number[];
  /** What an ACTIVE link still needs before a lesson can be booked on it. */
  missing: TeachingMissing[];
  createdAt: Date;
  decidedAt: Date | null;
  endedAt: Date | null;
}

/** One of a club's coaches, as the club sees them. */
export interface ClubCoach extends Terms {
  id: string;
  status: CoachLinkStatus;
  startedBy: 'COACH' | 'CLUB';
  venue: { id: string; name: string };
  coach: CoachCard;
  missing: TeachingMissing[];
  createdAt: Date;
  decidedAt: Date | null;
}

const LINK_SELECT = {
  id: true,
  tenantId: true,
  venueId: true,
  userId: true,
  status: true,
  startedBy: true,
  hourlyRateCents: true,
  groupRateCents: true,
  currency: true,
  lessonMinutes: true,
  cancelCutoffHours: true,
  createdAt: true,
  decidedAt: true,
  endedAt: true,
  availability: {
    select: { dayOfWeek: true, openTime: true, closeTime: true },
    orderBy: [{ dayOfWeek: 'asc' }, { openTime: 'asc' }],
  },
} as const satisfies Prisma.CoachSelect;

type LinkRow = Prisma.CoachGetPayload<{ select: typeof LINK_SELECT }>;

function termsOf(row: LinkRow): Terms {
  return {
    hourlyRateCents: row.hourlyRateCents,
    groupRateCents: row.groupRateCents,
    currency: row.currency,
    lessonMinutes: row.lessonMinutes,
    cancelCutoffHours: row.cancelCutoffHours,
    hours: row.availability.map((a) => ({
      dayOfWeek: a.dayOfWeek,
      open: formatClock(minutesFromTimeColumn(a.openTime)),
      close: formatClock(minutesFromTimeColumn(a.closeTime)),
    })),
  };
}

const missingOf = (row: LinkRow): TeachingMissing[] =>
  row.status === 'ACTIVE'
    ? missingForLessons({
        hourlyRateCents: row.hourlyRateCents,
        lessonMinutes: row.lessonMinutes,
        hours: row.availability,
      })
    : [];

/** A minute of the day as the `time` column takes it: a Date pinned to 1970-01-01, UTC. */
const timeColumn = (minutes: number) => new Date(Date.UTC(1970, 0, 1, 0, minutes));

const COURT_LENGTHS = {
  minBookingMinutes: true,
  maxBookingMinutes: true,
  slotStepMinutes: true,
} as const;

/** The lengths the venue's courts in use are booked for. Bound to the club. */
async function lengthOptionsOf(db: PrismaClient, tenantId: string, venueId: string) {
  const courts = await db.resource.findMany({
    where: { tenantId, venueId, status: 'ACTIVE' },
    select: COURT_LENGTHS,
    take: 200,
  });
  return lessonLengthOptions(courts);
}

// ─── The membership follows the links ──────────────────────────────────────

/**
 * Make the coach's standing at the club match their links there: COACH while
 * any is ACTIVE, PLAYER otherwise (and nothing at all if they were never
 * anything). Never touches a role a club's staff holds, and never lifts a
 * suspension: both are the club's own acts.
 */
async function syncCoachMembership(
  db: PrismaClient,
  tenantId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const [active, membership] = await Promise.all([
    db.coach.count({ where: { tenantId, userId, status: 'ACTIVE' } }),
    db.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true, role: true },
    }),
  ]);
  if (active > 0) {
    if (!membership) {
      await db.tenantMembership.create({
        data: { tenantId, userId, role: 'COACH', status: 'ACTIVE', acceptedAt: now },
      });
    } else if (membership.role === 'PLAYER') {
      await db.tenantMembership.updateMany({
        where: { id: membership.id, tenantId },
        data: { role: 'COACH' },
      });
    }
  } else if (membership?.role === 'COACH') {
    await db.tenantMembership.updateMany({
      where: { id: membership.id, tenantId },
      data: { role: 'PLAYER' },
    });
  }
}

/** Lock one link of this club for the transaction; undefined if it is not there. */
async function lockLink(db: PrismaClient, tenantId: string, linkId: string, userId?: string) {
  const rows = await db.$queryRaw<
    Array<{ id: string; userId: string; venueId: string; status: CoachLinkStatus }>
  >`
    SELECT "id", "userId", "venueId", "status"::text AS "status" FROM "coach"
    WHERE "id" = ${linkId} AND "tenantId" = ${tenantId}
      ${userId ? Prisma.sql`AND "userId" = ${userId}` : Prisma.empty}
    FOR UPDATE`;
  return rows[0];
}

/** End a link, by whoever: no new lessons, no hours; the row and its lessons stay. */
async function end(
  db: PrismaClient,
  link: { id: string; userId: string; venueId: string; status: CoachLinkStatus },
  by: { tenantId: string; actorUserId: string },
  now: Date,
): Promise<void> {
  await db.coachAvailability.deleteMany({ where: { tenantId: by.tenantId, coachId: link.id } });
  await db.coach.updateMany({
    where: { id: link.id, tenantId: by.tenantId },
    data: { status: 'ENDED', endedAt: now, endedByUserId: by.actorUserId },
  });
  await syncCoachMembership(db, by.tenantId, link.userId, now);
  await appendAuditEntry(db, {
    tenantId: by.tenantId,
    actorUserId: by.actorUserId,
    entity: 'Coach',
    entityId: link.id,
    action: AUDIT_ACTIONS.COACH_LINK_ENDED,
    details:
      by.actorUserId === link.userId
        ? 'The coach ended teaching at a venue'
        : 'The club ended a coach teaching at a venue',
    detailsJson: {
      category: 'access',
      summary: 'Coach link ended',
      before: { status: link.status },
      after: { status: 'ENDED', venueId: link.venueId, coachUserId: link.userId },
    },
  });
}

// ═══ THE COACH'S SIDE ══════════════════════════════════════════════════════

/** A COACH account that is still there, and whether the platform approved its profile. */
async function coachStanding(userId: string): Promise<{ approved: boolean }> {
  return runAsUserOnly(userId, async (db) => {
    const [user, profile] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { accountKind: true, deletedAt: true },
      }),
      db.coachProfile.findUnique({ where: { userId }, select: { status: true } }),
    ]);
    if (!user || user.deletedAt || user.accountKind !== 'COACH') {
      throw new CoachAccountRequiredError();
    }
    return { approved: profile?.status === 'APPROVED' };
  });
}

/** The most links one coach is shown; nobody teaches at this many venues. */
const MY_LINKS_MAX = 100;

/**
 * Every venue the coach teaches at, asked, or once taught at, newest first,
 * with the terms there. The one read here that spans clubs, keyed on the
 * coach's own account.
 */
export async function myCoachLinks(
  userId: string,
): Promise<{ approved: boolean; links: MyCoachLink[] }> {
  const { approved } = await coachStanding(userId);

  // guardrail-allow: cross-tenant — a coach teaches at several clubs; these are
  // the coach's OWN links, found by their account, with the names of the
  // venues and clubs they are at (public: the venue index lists them).
  const links = await runAsSuperuser(async (db) => {
    const rows = await db.coach.findMany({
      where: { userId },
      select: {
        ...LINK_SELECT,
        venue: {
          select: {
            id: true,
            name: true,
            city: true,
            timezone: true,
            resources: { where: { status: 'ACTIVE' }, select: COURT_LENGTHS, take: 200 },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MY_LINKS_MAX,
    });
    const clubs = await db.venueOrg.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
      select: { id: true, name: true, slug: true },
      take: MY_LINKS_MAX,
    });
    const clubOf = new Map(clubs.map((c) => [c.id, c]));
    return rows.flatMap((r): MyCoachLink[] => {
      const club = clubOf.get(r.tenantId);
      if (!club) return [];
      return [
        {
          id: r.id,
          status: r.status,
          startedBy: r.startedBy === 'CLUB' ? 'CLUB' : 'COACH',
          club: { name: club.name, slug: club.slug },
          venue: {
            id: r.venue.id,
            name: r.venue.name,
            city: r.venue.city,
            timezone: r.venue.timezone,
          },
          lengthOptions: lessonLengthOptions(r.venue.resources),
          missing: missingOf(r),
          createdAt: r.createdAt,
          decidedAt: r.decidedAt,
          endedAt: r.endedAt,
          ...termsOf(r),
        },
      ];
    });
  });
  return { approved, links };
}

/** Which club a venue belongs to, if it and its club are open for business. */
async function clubOfVenue(venueId: string): Promise<string | null> {
  // guardrail-allow: cross-tenant — the coach names a venue by its id and is
  // nothing at its club yet; which club it belongs to is public (the venue
  // index says so). One read, and everything after it is bound to that club.
  return runAsSuperuser(async (db) => {
    // The one definition of "public": the venue AND its club are ACTIVE (#298).
    const publicVenue = await publicVenueFilter(db);
    const venue = await db.venue.findFirst({
      where: { id: venueId, ...publicVenue.where },
      select: { tenantId: true },
    });
    return venue?.tenantId ?? null;
  });
}

/** Which club one of the coach's OWN links belongs to. */
async function clubOfMyLink(userId: string, linkId: string): Promise<string> {
  // guardrail-allow: cross-tenant — found by the link's id AND the coach's own
  // account, so it can only ever name a link of the caller's. One read, and
  // everything after it is bound to that club.
  const link = await runAsSuperuser((db) =>
    db.coach.findFirst({ where: { id: linkId, userId }, select: { tenantId: true } }),
  );
  if (!link) throw new CoachLinkNotFoundError();
  return link.tenantId;
}

/**
 * An approved coach asks to teach at a venue. The club's owner or manager
 * then accepts or declines.
 *
 * A link that was declined or ended can be asked for again: it starts over as
 * a new request, keeping the terms the coach had there. One that is waiting
 * or running is `CoachLinkExistsError`.
 */
export async function requestToTeach(
  userId: string,
  venueId: string,
  now: Date = new Date(),
): Promise<{ linkId: string }> {
  const { approved } = await coachStanding(userId);
  if (!approved) throw new CoachNotApprovedError();
  const tenantId = await clubOfVenue(venueId);
  if (!tenantId) throw new CoachVenueNotFoundError();

  try {
    return await runInTenantContext(tenantId, async (db) => {
      const membership = await db.tenantMembership.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
        select: { status: true },
      });
      if (membership && membership.status !== 'ACTIVE') throw new CoachSuspendedAtClubError();

      const existing = await db.$queryRaw<Array<{ id: string; status: CoachLinkStatus }>>`
        SELECT "id", "status"::text AS "status" FROM "coach"
        WHERE "tenantId" = ${tenantId} AND "venueId" = ${venueId} AND "userId" = ${userId}
        FOR UPDATE`;
      const old = existing[0];
      if (old && LIVE.includes(old.status)) throw new CoachLinkExistsError(old.status);

      const fresh = {
        status: 'REQUESTED' as const,
        startedBy: 'COACH',
        decidedAt: null,
        decidedByUserId: null,
        endedAt: null,
        endedByUserId: null,
      };
      let linkId: string;
      if (old) {
        await db.coach.updateMany({ where: { id: old.id, tenantId }, data: fresh });
        linkId = old.id;
      } else {
        const made = await db.coach.create({
          data: { tenantId, venueId, userId, ...fresh },
          select: { id: true },
        });
        linkId = made.id;
      }
      await appendAuditEntry(db, {
        tenantId,
        actorUserId: userId,
        entity: 'Coach',
        entityId: linkId,
        action: AUDIT_ACTIONS.COACH_REQUESTED,
        details: 'A coach asked to teach at a venue',
        detailsJson: {
          category: 'access',
          summary: 'Coach asked to teach',
          after: { venueId, coachUserId: userId, status: 'REQUESTED' },
        },
      });
      return { linkId };
    });
  } catch (err) {
    // Two requests at once: the unique index let one through. The other is
    // told what the first one made.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new CoachLinkExistsError('REQUESTED');
    }
    throw err;
  }
}

/**
 * The coach ends a link, or takes a request back. Lessons already booked
 * stay; no new ones can be.
 */
export async function endMyLink(
  userId: string,
  linkId: string,
  now: Date = new Date(),
): Promise<void> {
  await coachStanding(userId);
  const tenantId = await clubOfMyLink(userId, linkId);
  await runInTenantContext(tenantId, async (db) => {
    const link = await lockLink(db, tenantId, linkId, userId);
    if (!link) throw new CoachLinkNotFoundError();
    if (!LIVE.includes(link.status)) throw new CoachLinkStateError(link.status);
    await end(db, link, { tenantId, actorUserId: userId }, now);
  });
}

/**
 * The coach sets the rates, the lengths taught and the cancellation cutoff
 * at one venue. For a link the club has agreed to: terms on a request nobody
 * answered would be terms for nothing.
 */
export async function saveTeachingTerms(
  userId: string,
  linkId: string,
  raw: {
    hourlyRateCents?: unknown;
    groupRateCents?: unknown;
    lessonMinutes?: unknown;
    cancelCutoffHours?: unknown;
  },
): Promise<void> {
  await coachStanding(userId);
  const tenantId = await clubOfMyLink(userId, linkId);
  await runInTenantContext(tenantId, async (db) => {
    const link = await lockLink(db, tenantId, linkId, userId);
    if (!link) throw new CoachLinkNotFoundError();
    if (link.status !== 'ACTIVE') throw new CoachLinkStateError(link.status);

    const terms = readTeachingTerms(raw, await lengthOptionsOf(db, tenantId, link.venueId));
    const before = await db.coach.findFirst({
      where: { id: linkId, tenantId },
      select: {
        hourlyRateCents: true,
        groupRateCents: true,
        lessonMinutes: true,
        cancelCutoffHours: true,
      },
    });
    if (before && JSON.stringify(before) === JSON.stringify(terms)) return;

    await db.coach.updateMany({ where: { id: linkId, tenantId }, data: terms });
    await appendAuditEntry(db, {
      tenantId,
      actorUserId: userId,
      entity: 'Coach',
      entityId: linkId,
      action: AUDIT_ACTIONS.COACH_TERMS_CHANGED,
      details: 'A coach changed their rates, lengths or cancellation cutoff',
      detailsJson: {
        category: 'config',
        summary: 'Coach terms changed',
        before: before ?? {},
        after: { ...terms },
      },
    });
  });
}

/**
 * The coach sets the weekly hours they teach at one venue, replacing the
 * week that was there. An empty week is valid: no regular hours here.
 */
export async function saveTeachingHours(
  userId: string,
  linkId: string,
  rawHours: unknown,
): Promise<void> {
  await coachStanding(userId);
  const hours = readTeachingHours(rawHours);
  const tenantId = await clubOfMyLink(userId, linkId);
  await runInTenantContext(tenantId, async (db) => {
    const link = await lockLink(db, tenantId, linkId, userId);
    if (!link) throw new CoachLinkNotFoundError();
    if (link.status !== 'ACTIVE') throw new CoachLinkStateError(link.status);

    await db.coachAvailability.deleteMany({ where: { tenantId, coachId: linkId } });
    if (hours.length > 0) {
      await db.coachAvailability.createMany({
        data: hours.map((h) => ({
          tenantId,
          coachId: linkId,
          dayOfWeek: h.dayOfWeek,
          openTime: timeColumn(h.openMinute),
          closeTime: timeColumn(h.closeMinute),
        })),
      });
    }
    await appendAuditEntry(db, {
      tenantId,
      actorUserId: userId,
      entity: 'Coach',
      entityId: linkId,
      action: AUDIT_ACTIONS.COACH_TERMS_CHANGED,
      details: 'A coach changed their weekly hours',
      detailsJson: {
        category: 'config',
        summary: 'Coach hours changed',
        after: {
          hours: hours.map((h) => ({
            dayOfWeek: h.dayOfWeek,
            open: formatClock(h.openMinute),
            close: formatClock(h.closeMinute),
          })),
        },
      },
    });
  });
}

// ═══ THE CLUB'S SIDE ═══════════════════════════════════════════════════════

interface Actor {
  tenantId: string;
  actorUserId: string;
}

/** The most coaches one club's page lists. */
export const CLUB_COACHES_MAX = 200;

/**
 * The club's coaches and the requests waiting for it, waiting first, with
 * each coach's public card.
 *
 * Two reads, one after the other and never one inside the other: the links,
 * bound to the club; then the cards, which are a person's and not the club's
 * (`coach-directory.ts`). Binds for itself, for that reason.
 */
export async function listClubCoaches(tenantId: string): Promise<ClubCoach[]> {
  const rows = await runInTenantContext(tenantId, (db) =>
    db.coach.findMany({
      where: { tenantId, status: { in: ['REQUESTED', 'ACTIVE'] } },
      select: { ...LINK_SELECT, venue: { select: { id: true, name: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: CLUB_COACHES_MAX,
    }),
  );
  const cards = await coachCards(rows.map((r) => r.userId));
  return rows.flatMap((r): ClubCoach[] => {
    const coach = cards.get(r.userId);
    // An account that is gone has no card and teaches nowhere.
    if (!coach) return [];
    return [
      {
        id: r.id,
        status: r.status,
        startedBy: r.startedBy === 'CLUB' ? 'CLUB' : 'COACH',
        venue: r.venue,
        coach,
        missing: missingOf(r),
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        ...termsOf(r),
      },
    ];
  });
}

/**
 * The club accepts or declines a coach's request. Accepting makes the coach
 * one of the club's (`syncCoachMembership`); a person the club suspended is
 * not taken on until it lifts that.
 */
export async function answerCoachRequest(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  accept: boolean,
  now: Date = new Date(),
): Promise<void> {
  const link = await lockLink(db, actor.tenantId, linkId);
  if (!link) throw new CoachLinkNotFoundError();
  if (link.status !== 'REQUESTED') throw new CoachLinkStateError(link.status);

  if (accept) {
    const membership = await db.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: link.userId, tenantId: actor.tenantId } },
      select: { status: true },
    });
    if (membership && membership.status !== 'ACTIVE') throw new CoachSuspendedAtClubError();
  }

  const next = accept ? ('ACTIVE' as const) : ('DECLINED' as const);
  await db.coach.updateMany({
    where: { id: linkId, tenantId: actor.tenantId },
    data: { status: next, decidedAt: now, decidedByUserId: actor.actorUserId },
  });
  if (accept) await syncCoachMembership(db, actor.tenantId, link.userId, now);
  await appendAuditEntry(db, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    entity: 'Coach',
    entityId: linkId,
    action: accept ? AUDIT_ACTIONS.COACH_ACCEPTED : AUDIT_ACTIONS.COACH_DECLINED,
    details: accept ? 'The club accepted a coach' : 'The club declined a coach',
    detailsJson: {
      category: 'access',
      summary: accept ? 'Coach accepted' : 'Coach declined',
      before: { status: 'REQUESTED' },
      after: { status: next, venueId: link.venueId, coachUserId: link.userId },
    },
  });
}

/** The club ends a coach teaching at a venue, or turns away a request by ending it. */
export async function endCoachLink(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  now: Date = new Date(),
): Promise<void> {
  const link = await lockLink(db, actor.tenantId, linkId);
  if (!link) throw new CoachLinkNotFoundError();
  if (!LIVE.includes(link.status)) throw new CoachLinkStateError(link.status);
  await end(db, link, actor, now);
}

/**
 * A coach accepted the club's email invitation: they teach at every venue the
 * club runs, from now. Both sides have agreed (the club by inviting, the coach
 * by accepting), so the links are ACTIVE at once; the coach then sets hours
 * where they actually teach, and a venue with none simply offers no lesson.
 *
 * Called by `acceptInvite` for a COACH invitation, in its transaction, after
 * it made the membership. A venue the coach already has a live link at is
 * left as it is; one that was declined or ended starts again.
 */
export async function linkInvitedCoach(
  db: PrismaClient,
  input: { tenantId: string; userId: string; invitedByUserId: string | null },
  now: Date = new Date(),
): Promise<number> {
  const { tenantId, userId } = input;
  const [venues, existing] = await Promise.all([
    db.venue.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: CLUB_COACHES_MAX,
    }),
    db.coach.findMany({
      where: { tenantId, userId },
      select: { id: true, venueId: true, status: true },
      take: CLUB_COACHES_MAX,
    }),
  ]);
  const have = new Map(existing.map((e) => [e.venueId, e]));
  const agreed = {
    status: 'ACTIVE' as const,
    startedBy: 'CLUB',
    decidedAt: now,
    decidedByUserId: userId,
    endedAt: null,
    endedByUserId: null,
  };
  let made = 0;
  for (const v of venues) {
    const old = have.get(v.id);
    if (old && LIVE.includes(old.status) && old.status !== 'REQUESTED') continue;
    let linkId: string;
    if (old) {
      await db.coach.updateMany({ where: { id: old.id, tenantId }, data: agreed });
      linkId = old.id;
    } else {
      const row = await db.coach.create({
        data: { tenantId, venueId: v.id, userId, ...agreed },
        select: { id: true },
      });
      linkId = row.id;
    }
    made += 1;
    await appendAuditEntry(db, {
      tenantId,
      actorUserId: userId,
      entity: 'Coach',
      entityId: linkId,
      action: AUDIT_ACTIONS.COACH_ACCEPTED,
      details: 'A coach accepted the club’s invitation',
      detailsJson: {
        category: 'access',
        summary: 'Invited coach joined',
        after: {
          status: 'ACTIVE',
          venueId: v.id,
          coachUserId: userId,
          invitedByUserId: input.invitedByUserId,
        },
      },
    });
  }
  return made;
}
