import { type PrismaClient, type SportType } from '@prisma/client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { getOwnBooking, getResourceForBooking } from '@/app-layer/repositories/booking';
import { publicVenueFilter } from '@/app-layer/repositories/public-venue';
import { quoteBooking, SlotNotBookableError } from '@/app-layer/usecases/availability';
import { createBooking, SlotTakenError } from '@/app-layer/usecases/booking';
import { clubTakesOnlinePayment } from '@/app-layer/usecases/booking-rules';
import { resolvePlayerTenant } from '@/app-layer/usecases/club-membership';
import { readyLink } from '@/app-layer/usecases/coach-directory';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import {
  coachFeeCents,
  coachWorks,
  lessonTimes,
  type CoachOnTheDay,
  type CourtForLesson,
  type LessonTime,
} from '@/lib/coaches/lessons';
import { isDeadlock, isExclusionViolation } from '@/lib/db/pg-errors';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * BOOKING A LESSON (#548, #377; owner decisions 1, 2, 5, 9, 15).
 *
 * A lesson is a court booking with a coach on it: one `booking` row, as any
 * court booking, and one `coach_lesson` row beside it holding the coach, the
 * coach's terms as they were at that moment, and the coach's fee. The player
 * picks a time when both are free; the two are taken together or not at all.
 *
 * ═══ ONE BOOKING, TWO THINGS HELD ═══
 *
 * Both rows are written in one transaction bound to the club. The court is
 * held by `booking_no_overlap` (P05) and the coach by `coach_lesson_no_overlap`
 * (P71), which is on the coach's ACCOUNT, so it counts their lessons at every
 * club. Neither is checked first and trusted: each is an insert the database
 * refuses if somebody was faster, and a refusal of the second takes the first
 * down with it.
 *
 * The player is told WHICH went. When the court is refused the time is looked
 * at again, fresh: if another court is free the lesson is booked on that one
 * (the player chose a time, not a court); if the coach has meanwhile been
 * booked, which is what two people racing for one lesson looks like, they are
 * told the coach was (`CoachTakenError`); otherwise that no court is left
 * (`SlotTakenError`, as for a court booking).
 *
 * ═══ THE SAME RULES AS A COURT BOOKING ═══
 *
 * The player is joined to the club by `resolvePlayerTenant`, as the court
 * route does: an account that plays, with a confirmed phone, at a club that is
 * open, and not blocked there. The court booking itself is made by
 * `createBooking`, unchanged: the idempotency key, not in the past, the
 * no-show block, the cap on upcoming online bookings. A lesson is not a way
 * around any of them.
 *
 * ═══ WHAT IS CHARGED ═══
 *
 * The court's price is the court booking's own quote and is what the
 * booking's `totalCents` holds: the platform's fee is on the court part only
 * (decision 15). The coach's fee is the coach's hourly rate for the lesson's
 * length and is kept on the lesson. Both are shown; both are paid at the club.
 * A lesson is booked for one player; from the second player on, the fee
 * becomes the group rate (#549), which is why that rate is kept here too.
 *
 * ═══ WHY THE FIRST READ IS UNSCOPED ═══
 *
 * Whether a coach is free depends on their lessons at OTHER clubs and on
 * their days off, which are theirs alone (owner-only in the database). A
 * handle bound to one club sees neither. The read answers one question, "can
 * a lesson start then", and gives out nothing else: not where the other
 * lesson is, not that a day is a day off rather than a day not worked.
 */

// ─── Errors ────────────────────────────────────────────────────────────────

/** No such coach at a venue, or a lesson cannot be booked with them there. */
export class LessonLinkNotFoundError extends Error {
  constructor() {
    super('No coach can be booked there.');
    this.name = 'LessonLinkNotFoundError';
  }
}

/** The coach does not teach lessons of that length at this venue. */
export class LessonLengthNotOfferedError extends Error {
  constructor(readonly offered: number[]) {
    super(`The coach teaches lessons of ${offered.join(', ')} minutes here.`);
    this.name = 'LessonLengthNotOfferedError';
  }
}

/** The coach does not teach then: outside their hours, a day off, or already started. */
export class LessonTimeNotOfferedError extends Error {
  constructor() {
    super('The coach does not teach at that time.');
    this.name = 'LessonTimeNotOfferedError';
  }
}

/** The coach was booked for that time by somebody else, here or at another club. */
export class CoachTakenError extends Error {
  constructor() {
    super('The coach has just been booked for that time.');
    this.name = 'CoachTakenError';
  }
}

/** A coach does not book a lesson with themself. */
export class OwnLessonError extends Error {
  constructor() {
    super('You cannot book a lesson with yourself.');
    this.name = 'OwnLessonError';
  }
}

// ─── What can be booked ────────────────────────────────────────────────────

/** A coach at a venue, as far as booking a lesson needs to know. */
export interface LessonLink {
  linkId: string;
  tenantId: string;
  clubSlug: string;
  venue: { id: string; name: string; timezone: string };
  /** The club's cancellation cutoff at this venue, in hours before the start. */
  venueCutoffHours: number;
  coach: { userId: string; slug: string; name: string | null };
  hourlyRateCents: number;
  groupRateCents: number | null;
  currency: string;
  lessonMinutes: number[];
  /** The coach's own cutoff; a lesson follows the stricter of this and the club's (#549). */
  cancelCutoffHours: number;
  /** The sports a lesson can be in here: the coach's, on courts this venue has. */
  sports: SportType[];
}

/** A time a lesson can start, with what it would cost one player. */
export interface LessonOffer extends LessonTime {
  coachFeeCents: number;
  totalCents: number;
}

/** Why a lesson cannot start at a given time. */
export type NoLessonReason = 'NOT_OFFERED' | 'COACH_TAKEN' | 'NO_COURT';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The bookable link by its id, with the coach and venue; null for any other. */
async function bookableLink(db: PrismaClient, linkId: string): Promise<LessonLink | null> {
  const publicVenue = await publicVenueFilter(db);
  // guardrail-allow: cross-tenant — a public read: the link is named by its id
  // from the coach's public page, and is bookable only at a listed venue.
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      tenantId: string;
      venueId: string;
      venueName: string;
      timezone: string;
      venueCutoffHours: number;
      userId: string;
      slug: string;
      name: string | null;
      hourlyRateCents: number;
      groupRateCents: number | null;
      currency: string;
      lessonMinutes: number[];
      cancelCutoffHours: number;
      clubSlug: string;
    }>
  >`
    SELECT c."id", c."tenantId", c."venueId", v."name" AS "venueName", v."timezone",
           v."cancellationCutoffHours" AS "venueCutoffHours",
           c."userId", p."slug", u."name", c."hourlyRateCents", c."groupRateCents",
           c."currency", c."lessonMinutes", c."cancelCutoffHours", o."slug" AS "clubSlug"
      FROM "coach" c
      JOIN "venue" v ON v."id" = c."venueId"
      JOIN "venue_org" o ON o."id" = c."tenantId"
      JOIN "coach_profile" p ON p."userId" = c."userId" AND p."status" = 'APPROVED'
      JOIN "app_user" u ON u."id" = c."userId" AND u."deletedAt" IS NULL
     WHERE c."id" = ${linkId}
       AND ${readyLink(publicVenue)}
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;

  const [taught, courts] = await Promise.all([
    db.coachProfileSport.findMany({
      where: { userId: row.userId },
      select: { sport: true },
      take: 64,
    }),
    // guardrail-allow: cross-tenant — the venue's own courts, of the club the
    // link row above names.
    db.resource.findMany({
      where: { tenantId: row.tenantId, venueId: row.venueId, status: 'ACTIVE' },
      select: { sport: true },
      distinct: ['sport'],
      take: 64,
    }),
  ]);
  const here = new Set(courts.map((c) => c.sport));
  return {
    linkId: row.id,
    tenantId: row.tenantId,
    clubSlug: row.clubSlug,
    venue: { id: row.venueId, name: row.venueName, timezone: row.timezone },
    venueCutoffHours: row.venueCutoffHours,
    coach: { userId: row.userId, slug: row.slug, name: row.name },
    hourlyRateCents: row.hourlyRateCents,
    groupRateCents: row.groupRateCents,
    currency: row.currency,
    lessonMinutes: row.lessonMinutes,
    cancelCutoffHours: row.cancelCutoffHours,
    sports: taught.map((s) => s.sport).filter((s) => here.has(s)),
  };
}

/** The courts' free slots and the coach's day, for one calendar day at the venue. */
async function loadDay(
  db: PrismaClient,
  link: LessonLink,
  date: string,
  sport: SportType | undefined,
  now: Date,
): Promise<{ courts: CourtForLesson[]; coach: CoachOnTheDay } | null> {
  if (!DATE.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  // Local midnights, each resolved against that date's own offset, so the day
  // is a whole local day across a clock change too.
  const from = fromZonedTime(new Date(y, m - 1, d, 0, 0, 0, 0), link.venue.timezone);
  const to = fromZonedTime(new Date(y, m - 1, d + 1, 0, 0, 0, 0), link.venue.timezone);
  if (Number.isNaN(from.getTime()) || to.getTime() <= now.getTime()) return null;

  const wanted = sport ? link.sports.filter((s) => s === sport) : link.sports;
  if (wanted.length === 0) return null;

  const day = new Date(Date.UTC(y, m - 1, d));
  const [resources, hours, busy, off] = await Promise.all([
    loadVenueAvailability(db, { venue: link.venue, from, to }),
    // guardrail-allow: cross-tenant — the hours of the one link being booked.
    db.coachAvailability.findMany({
      where: { tenantId: link.tenantId, coachId: link.linkId },
      select: { dayOfWeek: true, openTime: true, closeTime: true },
      take: 64,
    }),
    // guardrail-allow: cross-tenant — the coach's lessons that touch the day
    // at ANY club: a coach is in one place at a time.
    db.coachLesson.findMany({
      where: {
        coachUserId: link.coach.userId,
        active: true,
        startTs: { lt: to },
        endTs: { gt: from },
      },
      select: { startTs: true, endTs: true },
      take: 200,
    }),
    db.coachTimeOff.count({
      where: { userId: link.coach.userId, startDate: { lte: day }, endDate: { gte: day } },
    }),
  ]);

  return {
    coach: {
      hours: hours.map((h) => ({
        dayOfWeek: h.dayOfWeek,
        openMinute: minutesFromTimeColumn(h.openTime),
        closeMinute: minutesFromTimeColumn(h.closeTime),
      })),
      busy,
      off: off > 0,
    },
    courts: resources
      .filter((r) => wanted.includes(r.resource.sport as SportType))
      .map((r) => ({
        resourceId: r.resource.id,
        name: r.resource.name,
        sport: r.resource.sport,
        slots: r.slots.flatMap((s) =>
          s.available && s.durations ? [{ startTs: s.startTs, durations: s.durations }] : [],
        ),
      })),
  };
}

const priced = (link: LessonLink, minutes: number, times: LessonTime[]): LessonOffer[] => {
  const fee = coachFeeCents(link.hourlyRateCents, minutes);
  return times.map((t) => ({ ...t, coachFeeCents: fee, totalCents: fee + t.courtPriceCents }));
};

/**
 * The times a lesson of `minutes` can start with this coach at this venue on
 * one calendar day there, with the price for one player.
 *
 * Throws `LessonLinkNotFoundError` for a link nobody can book on, and
 * `LessonLengthNotOfferedError` for a length the coach does not teach here.
 * `sport` narrows to that sport's courts; without it, any sport the coach
 * teaches that the venue has a court for.
 */
export async function lessonTimesFor(input: {
  linkId: string;
  /** `YYYY-MM-DD`, a calendar day at the venue. */
  date: string;
  minutes: number;
  sport?: SportType;
  now?: Date;
}): Promise<{ link: LessonLink; times: LessonOffer[] }> {
  const now = input.now ?? new Date();
  return runAsSuperuser(async (db) => {
    const link = await bookableLink(db, input.linkId);
    if (!link) throw new LessonLinkNotFoundError();
    if (!link.lessonMinutes.includes(input.minutes)) {
      throw new LessonLengthNotOfferedError(link.lessonMinutes);
    }
    const day = await loadDay(db, link, input.date, input.sport, now);
    if (!day) return { link, times: [] };
    const times = lessonTimes({
      minutes: input.minutes,
      timezone: link.venue.timezone,
      now,
      ...day,
    });
    return { link, times: priced(link, input.minutes, times) };
  });
}

/**
 * Whether a lesson can start at exactly `startTs`, and on which court; when
 * it cannot, why. Never throws for "cannot": the caller decides, after it has
 * looked for a replay.
 */
async function lessonOfferAt(input: {
  linkId: string;
  startTs: Date;
  minutes: number;
  sport?: SportType;
  now: Date;
}): Promise<{ link: LessonLink; offer: LessonOffer | null; why: NoLessonReason | null }> {
  return runAsSuperuser(async (db) => {
    const link = await bookableLink(db, input.linkId);
    if (!link) throw new LessonLinkNotFoundError();
    if (!link.lessonMinutes.includes(input.minutes)) {
      throw new LessonLengthNotOfferedError(link.lessonMinutes);
    }
    if (Number.isNaN(input.startTs.getTime())) return { link, offer: null, why: 'NOT_OFFERED' };

    const { timezone } = link.venue;
    const date = formatInTimeZone(input.startTs, timezone, 'yyyy-MM-dd');
    const day = await loadDay(db, link, date, input.sport, input.now);
    if (!day) return { link, offer: null, why: 'NOT_OFFERED' };

    const times = lessonTimes({ minutes: input.minutes, timezone, now: input.now, ...day });
    const found = times.find((t) => t.startTs.getTime() === input.startTs.getTime());
    if (found) return { link, offer: priced(link, input.minutes, [found])[0]!, why: null };

    const endTs = new Date(input.startTs.getTime() + input.minutes * 60_000);
    if (
      day.coach.off ||
      input.startTs.getTime() <= input.now.getTime() ||
      !coachWorks(day.coach.hours, input.startTs, endTs, timezone)
    ) {
      return { link, offer: null, why: 'NOT_OFFERED' };
    }
    const taken = day.coach.busy.some(
      (b) => input.startTs.getTime() < b.endTs.getTime() && b.startTs.getTime() < endTs.getTime(),
    );
    return { link, offer: null, why: taken ? 'COACH_TAKEN' : 'NO_COURT' };
  });
}

// ─── Booking it ────────────────────────────────────────────────────────────

/** What a booking is told about the lesson on it. */
export interface BookedLesson {
  lessonId: string;
  coach: { slug: string; name: string | null };
  minutes: number;
  coachFeeCents: number;
  /** The rate from the second player on; null when the coach gives no group lessons. */
  groupRateCents: number | null;
  courtPriceCents: number;
  totalCents: number;
  currency: string;
}

export interface BookLessonInput {
  userId: string;
  /** The coach the link is named under; a link under any other coach is not there. */
  coachSlug?: string;
  linkId: string;
  startTs: Date;
  minutes: number;
  sport?: SportType;
  idempotencyKey: string;
  notes?: string | null;
  now?: Date;
}

export interface BookLessonResult {
  tenantId: string;
  venueId: string;
  bookingId: string;
  /** True when an existing booking was returned for a repeated key. */
  replay: boolean;
  booking: NonNullable<Awaited<ReturnType<typeof getOwnBooking>>>;
  lesson: BookedLesson;
}

/** How many courts a booking tries before saying none is left. */
const COURT_ATTEMPTS = 3;

/**
 * Book a lesson for `userId`: the court booking and the coach's lesson on it,
 * together or not at all.
 */
export async function bookLesson(input: BookLessonInput): Promise<BookLessonResult> {
  const now = input.now ?? new Date();

  for (let attempt = 1; ; attempt++) {
    const { link, offer, why } = await lessonOfferAt({ ...input, now });
    if (input.coachSlug !== undefined && link.coach.slug !== input.coachSlug) {
      throw new LessonLinkNotFoundError();
    }
    if (input.userId === link.coach.userId) throw new OwnLessonError();

    // The same door a court booking comes through: an account that plays,
    // with a confirmed phone, joined to an open club it is not blocked at.
    const standing = await resolvePlayerTenant(input.userId, link.clubSlug, {
      createIfAbsent: true,
    });
    if (!standing) throw new LessonLinkNotFoundError();

    try {
      return await runInTenantContext(link.tenantId, (db) =>
        bookOn(db, { ...input, now, link, offer, why }),
      );
    } catch (err) {
      // The court went between the look and the insert. Look again: another
      // court may be free, or it is the coach who is gone.
      if (err instanceof SlotTakenError && offer && attempt < COURT_ATTEMPTS) continue;
      throw err;
    }
  }
}

async function bookOn(
  db: PrismaClient,
  input: BookLessonInput & {
    now: Date;
    link: LessonLink;
    offer: LessonOffer | null;
    why: NoLessonReason | null;
  },
): Promise<BookLessonResult> {
  const { link, offer } = input;
  const tenantId = link.tenantId;
  const own = async (bookingId: string) => {
    const row = await getOwnBooking(db, tenantId, { bookingId, userId: input.userId });
    if (!row) throw new LessonLinkNotFoundError();
    return row;
  };

  // A retry of a lesson that was booked returns that lesson, even though its
  // own time is, because of it, no longer on offer. So this comes first.
  const replay = await db.booking.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
    select: { id: true, bookedByUserId: true },
  });
  if (replay) {
    const lesson =
      replay.bookedByUserId === input.userId ? await lessonOnBooking(db, link, replay.id) : null;
    // The key was used for something that is not this player's lesson here.
    if (!lesson) throw new LessonTimeNotOfferedError();
    return {
      tenantId,
      venueId: link.venue.id,
      bookingId: replay.id,
      replay: true,
      booking: await own(replay.id),
      lesson,
    };
  }

  if (!offer) {
    if (input.why === 'COACH_TAKEN') throw new CoachTakenError();
    if (input.why === 'NO_COURT') throw new SlotTakenError();
    throw new LessonTimeNotOfferedError();
  }

  // The court, by the court booking's own rules and at its own price.
  const resource = await getResourceForBooking(db, tenantId, offer.resourceId);
  if (!resource || resource.venue.id !== link.venue.id || resource.venue.status !== 'ACTIVE') {
    throw new SlotTakenError();
  }
  const endTs = new Date(input.startTs.getTime() + input.minutes * 60_000);
  let courtPriceCents: number;
  try {
    courtPriceCents = quoteBooking({
      startTs: input.startTs,
      endTs,
      timezone: resource.venue.timezone,
      basePriceCents: resource.basePriceCents,
      minBookingMinutes: resource.minBookingMinutes,
      maxBookingMinutes: resource.maxBookingMinutes,
      slotStepMinutes: resource.slotStepMinutes,
      windows: resource.availability.map((w) => ({
        dayOfWeek: w.dayOfWeek,
        openMinutes: minutesFromTimeColumn(w.openTime),
        closeMinutes: minutesFromTimeColumn(w.closeTime),
        effectiveFrom: w.effectiveFrom,
        effectiveTo: w.effectiveTo,
        exceptionDate: w.exceptionDate,
      })),
      pricingRules: resource.pricingRules.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        conditionsJson: r.conditionsJson as never,
        multiplier: r.multiplier as never,
        fixedPriceCents: r.fixedPriceCents,
      })),
    }).priceCents;
  } catch (err) {
    // The club changed the court's hours or lengths since the look.
    if (err instanceof SlotNotBookableError) throw new SlotTakenError();
    throw err;
  }

  const created = await createBooking(db, tenantId, {
    resourceId: resource.id,
    startTs: input.startTs,
    endTs,
    // The court part only: what the platform's fee is on (decision 15).
    totalCents: courtPriceCents,
    idempotencyKey: input.idempotencyKey,
    bookedByUserId: input.userId,
    notes: input.notes ?? null,
    onlinePayment: await clubTakesOnlinePayment(db, tenantId),
    now: input.now,
  });
  if (created.idempotentReplay) {
    // The same key, committed by a concurrent request while this one waited
    // for the player's lock: that request's lesson is this one's.
    const lesson = await lessonOnBooking(db, link, created.bookingId);
    if (!lesson) throw new LessonTimeNotOfferedError();
    return {
      tenantId,
      venueId: link.venue.id,
      bookingId: created.bookingId,
      replay: true,
      booking: await own(created.bookingId),
      lesson,
    };
  }

  const fee = coachFeeCents(link.hourlyRateCents, input.minutes);
  let lessonId: string;
  try {
    const lesson = await db.coachLesson.create({
      data: {
        tenantId,
        bookingId: created.bookingId,
        coachId: link.linkId,
        coachUserId: link.coach.userId,
        startTs: input.startTs,
        endTs,
        hourlyRateCents: link.hourlyRateCents,
        groupRateCents: link.groupRateCents,
        cancelCutoffHours: link.cancelCutoffHours,
        coachFeeCents: fee,
      },
      select: { id: true },
    });
    lessonId = lesson.id;
  } catch (err) {
    // The coach was booked for that time first, here or at another club. The
    // refusal aborts the transaction, so the court booking goes with it. A
    // deadlock is the same race lost at the same instant (see `createBooking`).
    if (isExclusionViolation(err) || isDeadlock(err)) throw new CoachTakenError();
    throw err;
  }

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: input.userId,
    entity: 'CoachLesson',
    entityId: lessonId,
    action: AUDIT_ACTIONS.COACH_LESSON_BOOKED,
    details: 'A player booked a lesson with a coach',
    detailsJson: {
      category: 'booking',
      summary: 'Lesson booked',
      after: {
        bookingId: created.bookingId,
        coachUserId: link.coach.userId,
        venueId: link.venue.id,
        minutes: input.minutes,
        coachFeeCents: fee,
        courtPriceCents,
      },
    },
  });

  return {
    tenantId,
    venueId: link.venue.id,
    bookingId: created.bookingId,
    replay: false,
    booking: await own(created.bookingId),
    lesson: {
      lessonId,
      coach: { slug: link.coach.slug, name: link.coach.name },
      minutes: input.minutes,
      coachFeeCents: fee,
      groupRateCents: link.groupRateCents,
      courtPriceCents,
      totalCents: fee + courtPriceCents,
      currency: link.currency,
    },
  };
}

/** The lesson already on a booking, when it is one with this coach here. */
async function lessonOnBooking(
  db: PrismaClient,
  link: LessonLink,
  bookingId: string,
): Promise<BookedLesson | null> {
  const lesson = await db.coachLesson.findFirst({
    where: { tenantId: link.tenantId, bookingId, coachId: link.linkId },
    select: {
      id: true,
      startTs: true,
      endTs: true,
      coachFeeCents: true,
      groupRateCents: true,
      booking: { select: { totalCents: true } },
    },
  });
  if (!lesson) return null;
  return {
    lessonId: lesson.id,
    coach: { slug: link.coach.slug, name: link.coach.name },
    minutes: Math.round((lesson.endTs.getTime() - lesson.startTs.getTime()) / 60_000),
    coachFeeCents: lesson.coachFeeCents,
    groupRateCents: lesson.groupRateCents,
    courtPriceCents: lesson.booking.totalCents,
    totalCents: lesson.coachFeeCents + lesson.booking.totalCents,
    currency: link.currency,
  };
}
