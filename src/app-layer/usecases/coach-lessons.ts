import { type BookingStatus, type PrismaClient, type SportType } from '@prisma/client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { getOwnBooking, getResourceForBooking } from '@/app-layer/repositories/booking';
import { publicVenueFilter } from '@/app-layer/repositories/public-venue';
import { quoteBooking, SlotNotBookableError } from '@/app-layer/usecases/availability';
import { cancelBooking, createBooking, SlotTakenError } from '@/app-layer/usecases/booking';
import { notifyBookingCancelled } from '@/app-layer/usecases/booking-notifications';
import { markNoShow } from '@/app-layer/usecases/booking-outcome';
import { clubTakesOnlinePayment } from '@/app-layer/usecases/booking-rules';
import { resolvePlayerTenant } from '@/app-layer/usecases/club-membership';
import { readyLink } from '@/app-layer/usecases/coach-directory';
import { CoachAccountRequiredError } from '@/app-layer/usecases/coach-profile';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { ratingIn, shownRatings, type ShownRating } from '@/app-layer/usecases/shown-ratings';
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
import { decryptField } from '@/lib/security/encryption';
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
 * The court is the server's choice, so the price is settled only here. A
 * client says what total it showed the player (`expectedTotalCents`), and a
 * lesson that would cost more than that is refused, not booked: nobody is
 * charged a price they did not see.
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

/**
 * The lesson can no longer be had for what the player was shown: the court
 * that price was for has gone, and the one left costs more. Nothing is booked;
 * the player sees the new price and decides again.
 */
export class LessonPriceChangedError extends Error {
  constructor(readonly totalCents: number) {
    super('The price of that lesson has changed.');
    this.name = 'LessonPriceChangedError';
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
  /**
   * The total the player was shown and agreed to. The court is chosen when
   * the lesson is booked, so it may not be the one that price was for; with
   * this set, a lesson that would now cost MORE is refused
   * (`LessonPriceChangedError`) rather than booked. One that costs the same
   * or less is booked.
   */
  expectedTotalCents?: number;
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
      // Out of courts, or none was on offer. When players race for one time,
      // the court each lost may have gone to the lesson that took the coach,
      // and the look they made was from before it: say what is true now
      // (#635), in a fresh read, since the failed transaction is gone.
      if (
        err instanceof SlotTakenError &&
        (await coachTakenAt(link, input.startTs, input.minutes))
      ) {
        throw new CoachTakenError();
      }
      throw err;
    }
  }
}

/** Whether the coach has a live lesson overlapping this time, anywhere (#635). */
async function coachTakenAt(link: LessonLink, startTs: Date, minutes: number): Promise<boolean> {
  const endTs = new Date(startTs.getTime() + minutes * 60_000);
  return runAsSuperuser(async (db) => {
    // guardrail-allow: cross-tenant — a coach is taken by a lesson at ANY club,
    // the same read the offer's busy times make (`loadDay`).
    const clash = await db.coachLesson.findFirst({
      where: {
        coachUserId: link.coach.userId,
        active: true,
        startTs: { lt: endTs },
        endTs: { gt: startTs },
      },
      select: { id: true },
    });
    return clash !== null;
  });
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

  const fee = coachFeeCents(link.hourlyRateCents, input.minutes);
  if (input.expectedTotalCents !== undefined && fee + courtPriceCents > input.expectedTotalCents) {
    throw new LessonPriceChangedError(fee + courtPriceCents);
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

// ═══ THE COACH'S OWN LESSONS ═══════════════════════════════════════════════

/** One lesson as the coach who teaches it sees it. */
export interface MyLesson {
  lessonId: string;
  bookingId: string;
  status: BookingStatus;
  startTs: Date;
  endTs: Date;
  venue: { id: string; name: string; timezone: string };
  club: string;
  court: { name: string; sport: string };
  /**
   * Who booked it, as far as a coach is shown a player (owner decision 12):
   * the name, the level they declared for this lesson's sport, and their
   * confirmed phone number while the lesson is still to come, so the coach
   * can call about it. Null for an account that is gone.
   */
  player: {
    name: string | null;
    /** 1 to 7 on the sport's scale; null when they have not said. */
    level: number | null;
    /** Their rating in the sport while ranking is on and they show it (#576); null otherwise. */
    rating: ShownRating | null;
    /** E.164. Upcoming lessons only, and only a number they confirmed. */
    phone: string | null;
  } | null;
  /** Everybody on the lesson: the player who booked it and those they added. */
  players: number;
  coachFeeCents: number;
  currency: string;
}

export const MY_LESSONS_PAGE = 20;
export const MY_LESSONS_MAX = 100;

/**
 * The lessons a coach teaches, at every club: UPCOMING (still on, not yet
 * over) soonest first, or PAST (over, or cancelled) newest first. The two
 * never overlap, and together they are every lesson.
 *
 * Read by the coach's own account and nothing else: `coachUserId` is the
 * caller's id from a verified session. It spans clubs, so it is not bound to
 * one; a lesson row belongs to its club under RLS, and no binding means
 * "mine, wherever I teach".
 */
export async function listMyLessons(input: {
  userId: string;
  when: 'upcoming' | 'past';
  limit?: number;
  cursor?: string | null;
  now?: Date;
}): Promise<{ items: MyLesson[]; nextCursor: string | null }> {
  const now = input.now ?? new Date();
  const take =
    !input.limit || input.limit < 1 ? MY_LESSONS_PAGE : Math.min(input.limit, MY_LESSONS_MAX);

  return runAsSuperuser(async (db) => {
    const account = await db.user.findUnique({
      where: { id: input.userId },
      select: { accountKind: true, deletedAt: true },
    });
    if (!account || account.deletedAt || account.accountKind !== 'COACH') {
      throw new CoachAccountRequiredError();
    }

    // guardrail-allow: cross-tenant — the coach's own lessons, at every club
    // they teach at; the filter is their session-derived id.
    const rows = await db.coachLesson.findMany({
      where: {
        coachUserId: input.userId,
        ...(input.when === 'upcoming'
          ? { active: true, endTs: { gt: now } }
          : { OR: [{ active: false }, { endTs: { lte: now } }] }),
      },
      orderBy:
        input.when === 'upcoming'
          ? [{ startTs: 'asc' }, { id: 'asc' }]
          : [{ startTs: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        tenantId: true,
        bookingId: true,
        startTs: true,
        endTs: true,
        coachFeeCents: true,
        coach: { select: { currency: true } },
        booking: {
          select: {
            status: true,
            bookedByUserId: true,
            _count: { select: { participants: true } },
            resource: {
              select: {
                name: true,
                sport: true,
                venue: { select: { id: true, name: true, timezone: true } },
              },
            },
          },
        },
      },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    if (page.length === 0) return { items: [], nextCursor: null };

    const playerIds = [...new Set(page.flatMap((r) => r.booking.bookedByUserId ?? []))];
    const tenantIds = [...new Set(page.map((r) => r.tenantId))];
    const [players, levels, clubs, ratings] = await Promise.all([
      db.user.findMany({
        where: { id: { in: playerIds }, deletedAt: null },
        // The number is read for every booker on the page and given out
        // below only for a lesson that is still to come.
        select: { id: true, name: true, phone: true, phoneVerifiedAt: true },
        take: Math.max(1, playerIds.length),
      }),
      // What each said of their own level, in the sports these lessons are in.
      db.playerSportLevel.findMany({
        where: {
          userId: { in: playerIds },
          sport: { in: [...new Set(page.map((r) => r.booking.resource.sport))] },
        },
        select: { userId: true, sport: true, level: true },
        take: Math.max(1, playerIds.length) * 16,
      }),
      db.venueOrg.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
        take: tenantIds.length,
      }),
      // What the coach may see of each one's rating (#576).
      shownRatings(db, playerIds, input.userId, now),
    ]);
    const playerOf = new Map(players.map((u) => [u.id, u]));
    const levelOf = new Map(levels.map((l) => [`${l.userId}|${l.sport}`, l.level]));
    const clubOf = new Map(clubs.map((c) => [c.id, c.name]));
    // ═══ THE PHONE, FOR A LESSON STILL TO COME AND NO OTHER (decision 12) ═══
    //
    // The rule a club's diary has (#500): the confirmed number of the player
    // on an UPCOMING booking, so that whoever is expecting them can call. A
    // lesson that is over, or was cancelled, shows none; a number this key
    // cannot read is left out rather than shown as ciphertext.
    const phoneFor = (r: (typeof page)[number], u: (typeof players)[number]) => {
      const upcoming =
        input.when === 'upcoming' &&
        (r.booking.status === 'PENDING' || r.booking.status === 'CONFIRMED') &&
        r.endTs.getTime() > now.getTime();
      if (!upcoming || !u.phone || !u.phoneVerifiedAt) return null;
      try {
        return decryptField(u.phone);
      } catch {
        return null;
      }
    };
    const playerFor = (r: (typeof page)[number]): MyLesson['player'] => {
      const u = r.booking.bookedByUserId ? playerOf.get(r.booking.bookedByUserId) : undefined;
      if (!u) return null;
      return {
        name: u.name,
        level: levelOf.get(`${u.id}|${r.booking.resource.sport}`) ?? null,
        rating: ratingIn(ratings, u.id, r.booking.resource.sport),
        phone: phoneFor(r, u),
      };
    };

    return {
      items: page.map((r) => ({
        lessonId: r.id,
        bookingId: r.bookingId,
        status: r.booking.status,
        startTs: r.startTs,
        endTs: r.endTs,
        venue: r.booking.resource.venue,
        club: clubOf.get(r.tenantId) ?? '',
        court: { name: r.booking.resource.name, sport: r.booking.resource.sport },
        player: playerFor(r),
        players: 1 + r.booking._count.participants,
        coachFeeCents: r.coachFeeCents,
        currency: r.coach.currency,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}

// ═══ THE COACH'S OWN ACTS ON A LESSON (#549) ═══════════════════════════════

/** No such lesson of the caller's: not theirs, or nobody's. One answer for both. */
export class LessonNotFoundError extends Error {
  constructor() {
    super('No such lesson.');
    this.name = 'LessonNotFoundError';
  }
}

/** Which club and booking one of the coach's OWN lessons is at. */
async function locateMyLesson(
  userId: string,
  lessonId: string,
): Promise<{ tenantId: string; bookingId: string }> {
  // guardrail-allow: cross-tenant — by the lesson's id AND the caller's own
  // account: a coach's lessons are at several clubs, and this finds which.
  const at = await runAsSuperuser((db) =>
    db.coachLesson.findFirst({
      where: { id: lessonId, coachUserId: userId },
      select: { tenantId: true, bookingId: true },
    }),
  );
  if (!at) throw new LessonNotFoundError();
  return at;
}

/**
 * The coach cancels one of their lessons (owner decision 8): until it starts,
 * with no cutoff of their own. The booking is cancelled with it, so the court
 * is released; the player, and anybody they added, is told by bell and email.
 *
 * `cancelBooking` does the work, as for every cancellation: the same record,
 * the same refund of anything paid online, the open-play clean-up. Its
 * `COACH` actor is the only thing a coach's cancel has of its own.
 */
export async function cancelMyLesson(input: {
  userId: string;
  lessonId: string;
  reason?: string;
  now?: Date;
}): Promise<{ bookingId: string }> {
  const at = await locateMyLesson(input.userId, input.lessonId);
  await runInTenantContext(
    at.tenantId,
    (db) =>
      cancelBooking(db, at.tenantId, {
        bookingId: at.bookingId,
        actor: 'COACH',
        cancelledByUserId: input.userId,
        reason: input.reason,
        now: input.now,
      }),
    undefined,
    { isolationLevel: 'Serializable' },
  );
  await notifyBookingCancelled({
    tenantId: at.tenantId,
    bookingId: at.bookingId,
    by: 'COACH',
    actorUserId: input.userId,
    now: input.now,
  });
  return { bookingId: at.bookingId };
}

/**
 * The coach records that the player did not come (owner decision 11). It is
 * the club's own no-show, made by `markNoShow` and held to its rules: only
 * once the lesson has started, never after the player reviewed it; and it
 * counts at that club exactly as one the desk marks, the block on online
 * booking included.
 */
export async function markMyLessonNoShow(input: {
  userId: string;
  lessonId: string;
  now?: Date;
}): Promise<{ bookingId: string }> {
  const at = await locateMyLesson(input.userId, input.lessonId);
  await runInTenantContext(at.tenantId, (db) =>
    markNoShow(db, at.tenantId, {
      bookingId: at.bookingId,
      actorUserId: input.userId,
      by: 'COACH',
      now: input.now,
    }),
  );
  return { bookingId: at.bookingId };
}
