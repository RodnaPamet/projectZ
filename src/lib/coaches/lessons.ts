import { toZonedTime } from 'date-fns-tz';

/**
 * When a lesson can be booked, and what it costs (#548; owner decisions 1, 2,
 * 5 and 9). Pure: the times are worked out from the courts' free slots and
 * the coach's week, both handed in, so the rule can be tested without a
 * database and reads the same wherever it is applied.
 *
 * A lesson is a court booking with a coach on it. So a time is offered when
 * BOTH are free for the whole lesson:
 *
 *   the court   has that start in its own grid, free, for that length (the
 *               court booking's own `slotDurations`, so a time offered here is
 *               one the court booking will accept and price the same)
 *   the coach   works then at this venue (weekly hours, in the venue's time),
 *               is not on a day off, and has no other lesson, at any club
 *
 * Like a court's slots this is a snapshot, not a promise: two people can be
 * shown the same time, and the database decides at the insert (the court's
 * exclusion constraint and the coach's, P05 and P71).
 */

/** What the coach charges for a lesson of this length, from an hourly rate. */
export function coachFeeCents(hourlyRateCents: number, minutes: number): number {
  return Math.round((hourlyRateCents * minutes) / 60);
}

/**
 * The coach's fee for a lesson with this many players (owner decisions 9, 18
 * and 19).
 *
 *   one player      the hourly rate, for the lesson's length
 *   two or more     the GROUP rate, for the lesson's length: one fee for the
 *                   whole group, not one per player
 *   no group rate   the hourly rate however many come: a coach who wants
 *                   more for a group says so by entering a group rate
 */
export function lessonFeeCents(input: {
  hourlyRateCents: number;
  groupRateCents: number | null;
  minutes: number;
  /** Everybody on the lesson: the player who booked it and those they added. */
  players: number;
}): number {
  const rate =
    input.players >= 2 && input.groupRateCents !== null
      ? input.groupRateCents
      : input.hourlyRateCents;
  return coachFeeCents(rate, input.minutes);
}

/** One free start on one court, with the lengths it can be booked for and their prices. */
export interface CourtSlot {
  startTs: Date;
  durations: ReadonlyArray<{ minutes: number; endTs: Date; priceCents: number }>;
}

export interface CourtForLesson {
  resourceId: string;
  name: string;
  sport: string;
  slots: readonly CourtSlot[];
}

/** A stretch of the coach's working week. `dayOfWeek` is 0 = Sunday … 6 = Saturday. */
export interface CoachStretch {
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

export interface CoachOnTheDay {
  hours: readonly CoachStretch[];
  /** The coach's other lessons that touch the day, at any club. */
  busy: ReadonlyArray<{ startTs: Date; endTs: Date }>;
  /** The day is one of the coach's days off. */
  off: boolean;
}

export interface LessonTime {
  startTs: Date;
  endTs: Date;
  /** The court the lesson would be on: the cheapest free one at that start. */
  resourceId: string;
  courtName: string;
  sport: string;
  courtPriceCents: number;
}

/**
 * Whether the coach works for the whole of [startTs, endTs), by the venue's
 * clock. Stretches that touch are one stretch (09:00–12:00 and 12:00–14:00
 * take a lesson from 11:30 to 12:30); a lesson never runs past the end of the
 * day, because no stretch does.
 */
export function coachWorks(
  hours: readonly CoachStretch[],
  startTs: Date,
  endTs: Date,
  timezone: string,
): boolean {
  const local = toZonedTime(startTs, timezone);
  const day = local.getDay();
  const from = local.getHours() * 60 + local.getMinutes();
  const to = from + (endTs.getTime() - startTs.getTime()) / 60_000;

  const today = hours
    .filter((h) => h.dayOfWeek === day)
    .map((h) => ({ open: h.openMinute, close: h.closeMinute }))
    .sort((a, b) => a.open - b.open);
  const merged: Array<{ open: number; close: number }> = [];
  for (const s of today) {
    const last = merged.at(-1);
    if (last && s.open <= last.close) last.close = Math.max(last.close, s.close);
    else merged.push({ ...s });
  }
  return merged.some((s) => s.open <= from && to <= s.close);
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) =>
  aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();

/**
 * The times a lesson of `minutes` can start, soonest first, one per start:
 * where two courts are free at the same time, the cheaper one (then by name,
 * so the answer is the same every time it is asked).
 */
export function lessonTimes(input: {
  minutes: number;
  timezone: string;
  courts: readonly CourtForLesson[];
  coach: CoachOnTheDay;
  now: Date;
}): LessonTime[] {
  if (input.coach.off) return [];
  const best = new Map<number, LessonTime>();

  for (const court of input.courts) {
    for (const slot of court.slots) {
      const length = slot.durations.find((d) => d.minutes === input.minutes);
      if (!length) continue;
      const { startTs } = slot;
      const { endTs } = length;
      // Not a time that has started: a court booking is refused the same way.
      if (startTs.getTime() <= input.now.getTime()) continue;
      if (!coachWorks(input.coach.hours, startTs, endTs, input.timezone)) continue;
      if (input.coach.busy.some((b) => overlaps(startTs, endTs, b.startTs, b.endTs))) continue;

      const candidate: LessonTime = {
        startTs,
        endTs,
        resourceId: court.resourceId,
        courtName: court.name,
        sport: court.sport,
        courtPriceCents: length.priceCents,
      };
      const held = best.get(startTs.getTime());
      if (
        !held ||
        candidate.courtPriceCents < held.courtPriceCents ||
        (candidate.courtPriceCents === held.courtPriceCents &&
          (candidate.courtName < held.courtName ||
            (candidate.courtName === held.courtName && candidate.resourceId < held.resourceId)))
      ) {
        best.set(startTs.getTime(), candidate);
      }
    }
  }
  return [...best.values()].sort((a, b) => a.startTs.getTime() - b.startTs.getTime());
}

/** What a lesson costs, in parts and in all. Paid at the club. */
export interface LessonPrice {
  /** The coach's fee: the hourly or the group rate, for the lesson's length. */
  coachFeeCents: number;
  courtPriceCents: number;
  totalCents: number;
}

export function lessonPrice(input: {
  minutes: number;
  courtPriceCents: number;
  hourlyRateCents: number;
  /** The rate for two or more players; null when the coach gives no group lessons. */
  groupRateCents: number | null;
  group: boolean;
}): LessonPrice {
  const rate =
    input.group && input.groupRateCents !== null ? input.groupRateCents : input.hourlyRateCents;
  const fee = coachFeeCents(rate, input.minutes);
  return {
    coachFeeCents: fee,
    courtPriceCents: input.courtPriceCents,
    totalCents: fee + input.courtPriceCents,
  };
}
