/**
 * What a coach sets for teaching at one venue, and their days off (#546;
 * owner decisions 2, 5, 6, 9 and 14). Pure: the form in the browser and the
 * use case on the server read the same rules from the same numbers. The
 * database holds the same limits as CHECKs (P71).
 */

/** Cents per hour. 1000 EUR an hour is a typo, not a rate. */
export const COACH_RATE_MAX_CENTS = 100_000;
/** Up to a week before; 0 means "until it starts". */
export const COACH_CUTOFF_MAX_HOURS = 168;
/** What a new link starts with, until the coach says otherwise. */
export const COACH_CUTOFF_DEFAULT_HOURS = 24;
/** Stretches of working time in one day: morning, afternoon, evening and one more. */
export const COACH_HOURS_PER_DAY_MAX = 4;
/** Working hours start and end on the quarter hour. */
export const COACH_HOURS_STEP_MINUTES = 15;
export const COACH_TIME_OFF_NOTE_MAX = 200;
/** Days off are planned at most this far ahead, and one stretch is at most this long. */
export const COACH_TIME_OFF_AHEAD_DAYS = 366;
export const COACH_TIME_OFF_MAX_DAYS = 92;
/** How many stretches of days off one coach keeps. */
export const COACH_TIME_OFF_MAX_ROWS = 50;

export type TeachingField =
  | 'hourlyRateCents'
  | 'groupRateCents'
  | 'lessonMinutes'
  | 'cancelCutoffHours'
  | 'hours'
  | 'startDate'
  | 'endDate'
  | 'note';

export type TeachingFieldError =
  | 'REQUIRED'
  | 'OUT_OF_RANGE'
  | 'NOT_A_COURT_LENGTH'
  | 'BAD_DAY'
  | 'BAD_TIME'
  | 'ENDS_BEFORE_IT_STARTS'
  | 'OVERLAP'
  | 'TOO_MANY'
  | 'BAD_DATE'
  | 'IN_THE_PAST'
  | 'TOO_FAR'
  | 'TOO_LONG';

export class TeachingInvalidError extends Error {
  constructor(
    readonly field: TeachingField,
    readonly reason: TeachingFieldError,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'TeachingInvalidError';
  }
}

// ─── Lengths ────────────────────────────────────────────────────────────────

/**
 * How long a court can be booked for: whole units of its minimum booking, up
 * to its maximum (`slotDurations`, which is what a court booking is priced
 * and accepted by). The court's step is only the grid its bookings START on.
 */
export interface CourtLengths {
  minBookingMinutes: number;
  maxBookingMinutes: number;
}

/** The most lengths one link keeps (coach_lesson_minutes, P71). */
export const COACH_LENGTHS_MAX = 12;

/**
 * The lengths a lesson at a venue can have: the lengths its courts are booked
 * for (owner decision 5). A lesson is a court booking with a coach on it, so
 * it cannot have a length no court here can be booked for. Each court has its
 * own (one by the hour, another by the hour and a half), so a venue's are
 * every length any of its courts allows, shortest first.
 *
 * A court booked by the hour for up to three allows 60, 120 and 180 minutes,
 * and NOT 90: a booking is a whole number of the court's units, whatever grid
 * it starts on. Offering a coach 90 there would be offering a lesson nobody
 * could ever book.
 *
 * Never under a quarter of an hour or over four hours, the database's own
 * bounds for a lesson; and at most twelve, the shortest ones.
 */
export function lessonLengthOptions(courts: readonly CourtLengths[]): number[] {
  const all = new Set<number>();
  for (const c of courts) {
    const unit = c.minBookingMinutes;
    if (!(unit > 0)) continue;
    const max = Math.min(c.maxBookingMinutes, 240);
    for (let m = unit; m <= max; m += unit) {
      if (m >= 15) all.add(m);
    }
  }
  return [...all].sort((a, b) => a - b).slice(0, COACH_LENGTHS_MAX);
}

// ─── Rates, lengths, cutoff ─────────────────────────────────────────────────

export interface TeachingTerms {
  hourlyRateCents: number;
  /** For two or more players (owner decision 9). Null: the coach gives no group lessons here. */
  groupRateCents: number | null;
  lessonMinutes: number[];
  cancelCutoffHours: number;
}

const wholeInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Read the terms as sent, against the lengths this venue's courts allow. */
export function readTeachingTerms(
  raw: {
    hourlyRateCents?: unknown;
    groupRateCents?: unknown;
    lessonMinutes?: unknown;
    cancelCutoffHours?: unknown;
  },
  lengths: readonly number[],
): TeachingTerms {
  if (raw.hourlyRateCents === undefined || raw.hourlyRateCents === null) {
    throw new TeachingInvalidError('hourlyRateCents', 'REQUIRED');
  }
  if (!wholeInRange(raw.hourlyRateCents, 0, COACH_RATE_MAX_CENTS)) {
    throw new TeachingInvalidError('hourlyRateCents', 'OUT_OF_RANGE');
  }
  const group = raw.groupRateCents ?? null;
  if (group !== null && !wholeInRange(group, 0, COACH_RATE_MAX_CENTS)) {
    throw new TeachingInvalidError('groupRateCents', 'OUT_OF_RANGE');
  }

  const list = Array.isArray(raw.lessonMinutes) ? raw.lessonMinutes : [];
  if (list.length === 0) throw new TeachingInvalidError('lessonMinutes', 'REQUIRED');
  const chosen = new Set<number>();
  for (const m of list) {
    if (typeof m !== 'number' || !lengths.includes(m)) {
      throw new TeachingInvalidError('lessonMinutes', 'NOT_A_COURT_LENGTH');
    }
    chosen.add(m);
  }

  const cutoff = raw.cancelCutoffHours ?? COACH_CUTOFF_DEFAULT_HOURS;
  if (!wholeInRange(cutoff, 0, COACH_CUTOFF_MAX_HOURS)) {
    throw new TeachingInvalidError('cancelCutoffHours', 'OUT_OF_RANGE');
  }

  return {
    hourlyRateCents: raw.hourlyRateCents,
    groupRateCents: group,
    // In the venue's own order, each once.
    lessonMinutes: lengths.filter((m) => chosen.has(m)),
    cancelCutoffHours: cutoff,
  };
}

// ─── Weekly hours ───────────────────────────────────────────────────────────

/** One stretch of working time. `dayOfWeek` is 0 = Sunday … 6 = Saturday, as the courts' hours are. */
export interface TeachingHours {
  dayOfWeek: number;
  /** Minutes from midnight, in the venue's time. */
  openMinute: number;
  closeMinute: number;
}

/**
 * `09:30` → 570. A time of day, so never 24:00: the hours are kept in `time`
 * columns, as the courts' are, where midnight is the START of a day. A coach
 * who works to the end of the day ends at 23:45.
 */
export function parseClock(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minutes >= 24 * 60) return null;
  return minutes;
}

/** 570 → `09:30`. */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Read a week of working hours. Each stretch starts and ends on the quarter
 * hour and ends after it starts; stretches on one day do not overlap (two
 * that touch are two stretches, which is fine). Sorted by day, then time.
 * An empty week is valid: the coach teaches no regular hours here.
 */
export function readTeachingHours(raw: unknown): TeachingHours[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: TeachingHours[] = [];
  for (const item of list) {
    const h = (item ?? {}) as { dayOfWeek?: unknown; open?: unknown; close?: unknown };
    if (!wholeInRange(h.dayOfWeek, 0, 6)) throw new TeachingInvalidError('hours', 'BAD_DAY');
    const open = parseClock(h.open);
    const close = parseClock(h.close);
    if (
      open === null ||
      close === null ||
      open % COACH_HOURS_STEP_MINUTES !== 0 ||
      close % COACH_HOURS_STEP_MINUTES !== 0
    ) {
      throw new TeachingInvalidError('hours', 'BAD_TIME');
    }
    if (close <= open) throw new TeachingInvalidError('hours', 'ENDS_BEFORE_IT_STARTS');
    out.push({ dayOfWeek: h.dayOfWeek, openMinute: open, closeMinute: close });
  }
  out.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.openMinute - b.openMinute);
  for (let i = 0; i < out.length; i++) {
    const sameDay = out.filter((h) => h.dayOfWeek === out[i]!.dayOfWeek);
    if (sameDay.length > COACH_HOURS_PER_DAY_MAX)
      throw new TeachingInvalidError('hours', 'TOO_MANY');
    const next = out[i + 1];
    if (next && next.dayOfWeek === out[i]!.dayOfWeek && next.openMinute < out[i]!.closeMinute) {
      throw new TeachingInvalidError('hours', 'OVERLAP');
    }
  }
  return out;
}

// ─── Days off ───────────────────────────────────────────────────────────────

export interface TimeOff {
  /** `YYYY-MM-DD`, both ends included. */
  startDate: string;
  endDate: string;
  note: string | null;
}

const DAY_MS = 86_400_000;

/** A real calendar date as `YYYY-MM-DD`, in UTC days since the epoch; null otherwise. */
function dayNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // 2026-02-31 parses in some engines by rolling over: it must read back the same.
  return new Date(ms).toISOString().slice(0, 10) === raw ? ms / DAY_MS : null;
}

/**
 * Read a stretch of days off. `today` is the calendar date where the coach
 * is (`YYYY-MM-DD`): a stretch may start today, and may not have ended.
 */
export function readTimeOff(
  raw: { startDate?: unknown; endDate?: unknown; note?: unknown },
  today: string,
): TimeOff {
  const start = dayNumber(raw.startDate);
  if (start === null) throw new TeachingInvalidError('startDate', 'BAD_DATE');
  // One day off is a stretch that ends the day it starts.
  const end = dayNumber(raw.endDate ?? raw.startDate);
  if (end === null) throw new TeachingInvalidError('endDate', 'BAD_DATE');
  if (end < start) throw new TeachingInvalidError('endDate', 'ENDS_BEFORE_IT_STARTS');
  const now = dayNumber(today)!;
  if (end < now) throw new TeachingInvalidError('endDate', 'IN_THE_PAST');
  if (start > now + COACH_TIME_OFF_AHEAD_DAYS)
    throw new TeachingInvalidError('startDate', 'TOO_FAR');
  if (end - start + 1 > COACH_TIME_OFF_MAX_DAYS)
    throw new TeachingInvalidError('endDate', 'TOO_LONG');

  const note = typeof raw.note === 'string' ? raw.note.replace(/\s+/g, ' ').trim() || null : null;
  if (note && note.length > COACH_TIME_OFF_NOTE_MAX)
    throw new TeachingInvalidError('note', 'TOO_LONG');
  return {
    startDate: raw.startDate as string,
    endDate: (raw.endDate ?? raw.startDate) as string,
    note,
  };
}

// ─── When a link is ready to take lessons ───────────────────────────────────

/**
 * What an ACTIVE link still needs before a player can book a lesson on it:
 * a rate, at least one length, and some working hours. (The platform's
 * approval of the coach is a separate thing, and is the profile's.)
 *
 * And `courts`, which is not the coach's to fix here: the venue has no court
 * in use for any sport the coach teaches, so there is nothing a lesson could
 * be on. Told to the coach rather than left as a link that looks ready and is
 * listed nowhere.
 */
export type TeachingMissing = 'courts' | 'rate' | 'lengths' | 'hours';

export function missingForLessons(link: {
  hourlyRateCents: number | null;
  lessonMinutes: readonly number[];
  hours: readonly unknown[];
  /** Courts in use at the venue for a sport the coach teaches. */
  courts: number;
}): TeachingMissing[] {
  return [
    ...(link.courts === 0 ? (['courts'] as const) : []),
    ...(link.hourlyRateCents === null ? (['rate'] as const) : []),
    ...(link.lessonMinutes.length === 0 ? (['lengths'] as const) : []),
    ...(link.hours.length === 0 ? (['hours'] as const) : []),
  ];
}
