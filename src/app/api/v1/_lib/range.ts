import { fromZonedTime } from 'date-fns-tz';

import { assertRangeWithinLimit, MAX_RANGE_DAYS } from '@/app-layer/usecases/availability';
import { ValidationError } from '@/lib/errors/types';

/**
 * Resolving "which day?" for an availability request.
 *
 * ═══ WHY `date` IS INTERPRETED IN THE VENUE'S ZONE ═══
 *
 * The obvious API is "send me two instants and I'll return what's between
 * them", and it pushes a timezone calculation onto the client. A native client
 * will do that calculation with `Calendar.current` — the DEVICE's zone.
 *
 * So a player in London tapping "Thursday" for a court in Sofia asks for
 * Thursday 00:00–24:00 London, which is Thursday 02:00 to Friday 02:00 in
 * Sofia. They get two hours of Friday, lose two hours of Thursday evening, and
 * nothing anywhere reports an error. It is worse for anyone who travels, which
 * for a sports booking app is a lot of people, and it is invisible to every
 * developer testing in the same timezone as the venue.
 *
 * `?date=2026-09-24` therefore means that calendar date AT THE CLUB, resolved
 * here where the venue's zone is known. `?from=/?to=` remain available for a
 * caller that genuinely means absolute instants.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A day is the sensible default window: it is what the booking screen shows. */
const DEFAULT_WINDOW_MS = 86_400_000;

export interface ResolvedRange {
  from: Date;
  to: Date;
}

function parseInstant(raw: string, field: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`Invalid ${field}: expected an RFC 3339 timestamp`, { field });
  }
  return d;
}

export function resolveAvailabilityRange(
  params: URLSearchParams,
  timezone: string,
  now: Date = new Date(),
): ResolvedRange {
  const date = params.get('date');
  const from = params.get('from');
  const to = params.get('to');

  if (date && (from || to)) {
    // Silently preferring one would make the other a no-op that looks like it
    // worked. A client sending both has a bug, and should hear about it.
    throw new ValidationError('Use either `date` or `from`/`to`, not both', {
      field: 'date',
    });
  }

  if (date) {
    if (!ISO_DATE.test(date)) {
      throw new ValidationError('Invalid date: expected YYYY-MM-DD', { field: 'date' });
    }

    const days = parseDays(params.get('days'));
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];

    // Month is 0-based. `fromZonedTime` resolves each local midnight against
    // that date's real offset, so a window spanning a changeover is still a
    // whole number of local days rather than a fixed multiple of 24 hours.
    const start = fromZonedTime(new Date(y, m - 1, d, 0, 0, 0, 0), timezone);
    const end = fromZonedTime(new Date(y, m - 1, d + days, 0, 0, 0, 0), timezone);

    if (Number.isNaN(start.getTime())) {
      throw new ValidationError('Invalid date', { field: 'date' });
    }

    return { from: start, to: end };
  }

  if (!from && !to) {
    return { from: now, to: new Date(now.getTime() + DEFAULT_WINDOW_MS) };
  }

  const start = from ? parseInstant(from, 'from') : now;
  const end = to ? parseInstant(to, 'to') : new Date(start.getTime() + DEFAULT_WINDOW_MS);

  if (end <= start) {
    throw new ValidationError('`to` must be after `from`', { field: 'to' });
  }

  // The `date`/`days` path is bounded by `parseDays`. This one was bounded by
  // nothing: `end > start` was its only rule, so a caller could ask for twenty
  // years and the route would query for them before anything checked the
  // width. Same ceiling, applied before a single row is read.
  assertRangeWithinLimit(start, end);

  return { from: start, to: end };
}

function parseDays(raw: string | null): number {
  if (raw === null) return 1;

  const n = Number(raw);
  // `Number('')` is 0 and `Number('2.5')` is 2.5 — both would otherwise slip
  // through an unguarded `parseInt`.
  if (!Number.isInteger(n) || n < 1 || n > MAX_RANGE_DAYS) {
    throw new ValidationError(`Invalid days: expected an integer between 1 and ${MAX_RANGE_DAYS}`, {
      field: 'days',
    });
  }
  return n;
}
