import { formatInTimeZone } from 'date-fns-tz';

import { rfc3339 } from './dto';

/**
 * Wire shapes for desk bookings and weekly series (#364), beside `dto.ts`.
 *
 * Every instant is RFC 3339 without fractional seconds (`rfc3339`), every
 * club-local date and time is resolved HERE in the venue's timezone, and
 * every status is an open string — the same three rules as `dto.ts`.
 */

/** A calendar date column (`@db.Date`) as `YYYY-MM-DD`. */
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** One week of a desk preview: when, what it would cost, and whether it can be booked. */
export interface DeskPreviewOccurrenceDto {
  /** The club-local date. */
  date: string;
  startTs: string;
  endTs: string;
  /** The server's quote in cents; null when `status` is `unavailable`. */
  quotedCents: number | null;
  /** `free`, `taken` or `unavailable`. Open string. */
  status: string;
}

export interface DeskPreviewDto {
  resource: { id: string; name: string };
  timezone: string;
  occurrences: DeskPreviewOccurrenceDto[];
}

export function toDeskPreview(p: {
  resource: { id: string; name: string; venue: { timezone: string } };
  occurrences: ReadonlyArray<{
    date: string;
    startTs: Date;
    endTs: Date;
    quotedCents: number | null;
    status: string;
  }>;
}): DeskPreviewDto {
  return {
    resource: { id: p.resource.id, name: p.resource.name },
    timezone: p.resource.venue.timezone,
    occurrences: p.occurrences.map((o) => ({
      date: o.date,
      startTs: rfc3339(o.startTs),
      endTs: rfc3339(o.endTs),
      quotedCents: o.quotedCents,
      status: o.status,
    })),
  };
}

/** A club player the desk can link a booking to. Never their phone. */
export interface DeskCustomerMatchDto {
  userId: string;
  name: string | null;
  email: string;
  /** `phone` or `name`. Open string. */
  matchedBy: string;
}

/**
 * A desk booking as the diary's detail sheet shows it.
 *
 * `customer.phone` is what the desk typed, normalised to E.164. `player` is the
 * linked account, if any: one of the club's players, so its name and email are
 * what the club's Players screen already shows.
 */
export interface DeskBookingDto {
  id: string;
  /** Open string, as `BookingDto.status`. */
  status: string;
  channel: string;
  startTs: string;
  endTs: string;
  /** Club-local, for display: `YYYY-MM-DD`, `HH:mm`, `HH:mm`. */
  date: string;
  startTime: string;
  endTime: string;
  totalCents: number;
  currency: string;
  notes: string | null;
  customer: { name: string | null; phone: string | null };
  player: { id: string; name: string | null; email: string } | null;
  resource: { id: string; name: string };
  venue: { id: string; name: string; timezone: string };
  series: {
    id: string;
    startTime: string;
    durationMinutes: number;
    firstDate: string;
    lastDate: string;
    cancelledFrom: string | null;
    /** Live occurrences from this one on, this one included. */
    remaining: number;
  } | null;
  cancelledAt: string | null;
  createdAt: string;
}

export function toDeskBooking(b: {
  id: string;
  status: string;
  channel: string;
  startTs: Date;
  endTs: Date;
  totalCents: number;
  currency: string;
  notes: string | null;
  guestName: string | null;
  guestPhone: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  resource: { id: string; name: string; venue: { id: string; name: string; timezone: string } };
  series: {
    id: string;
    startTime: string;
    durationMinutes: number;
    firstDate: Date;
    lastDate: Date;
    cancelledFrom: Date | null;
  } | null;
  player: { id: string; name: string | null; email: string } | null;
  seriesLeft: number;
}): DeskBookingDto {
  const tz = b.resource.venue.timezone;
  const wall = (d: Date, f: string) => formatInTimeZone(d, tz, f);
  return {
    id: b.id,
    status: b.status,
    channel: b.channel,
    startTs: rfc3339(b.startTs),
    endTs: rfc3339(b.endTs),
    date: wall(b.startTs, 'yyyy-MM-dd'),
    startTime: wall(b.startTs, 'HH:mm'),
    endTime: wall(b.endTs, 'HH:mm'),
    totalCents: b.totalCents,
    currency: b.currency,
    notes: b.notes,
    customer: { name: b.guestName, phone: b.guestPhone },
    player: b.player ? { id: b.player.id, name: b.player.name, email: b.player.email } : null,
    resource: { id: b.resource.id, name: b.resource.name },
    venue: { id: b.resource.venue.id, name: b.resource.venue.name, timezone: tz },
    series: b.series
      ? {
          id: b.series.id,
          startTime: b.series.startTime,
          durationMinutes: b.series.durationMinutes,
          firstDate: isoDate(b.series.firstDate),
          lastDate: isoDate(b.series.lastDate),
          cancelledFrom: b.series.cancelledFrom ? isoDate(b.series.cancelledFrom) : null,
          remaining: b.seriesLeft,
        }
      : null,
    cancelledAt: b.cancelledAt ? rfc3339(b.cancelledAt) : null,
    createdAt: rfc3339(b.createdAt),
  };
}

/** A weekly series and its occurrences. */
export interface BookingSeriesDto {
  id: string;
  resource: { id: string; name: string };
  startTime: string;
  durationMinutes: number;
  timezone: string;
  firstDate: string;
  lastDate: string;
  customer: { name: string; phone: string; userId: string | null };
  /** Staff's price for every week, or null for the quote per week. */
  priceCents: number | null;
  notes: string | null;
  cancelledFrom: string | null;
  createdAt: string;
  occurrences: Array<{
    bookingId: string;
    date: string;
    startTs: string;
    endTs: string;
    /** Open string. */
    status: string;
    totalCents: number;
  }>;
}

export function toBookingSeries(s: {
  id: string;
  startTime: string;
  durationMinutes: number;
  timezone: string;
  firstDate: Date;
  lastDate: Date;
  customerName: string;
  customerPhone: string;
  customerUserId: string | null;
  priceCents: number | null;
  notes: string | null;
  cancelledFrom: Date | null;
  createdAt: Date;
  resource: { id: string; name: string };
  bookings: ReadonlyArray<{
    id: string;
    startTs: Date;
    endTs: Date;
    status: string;
    totalCents: number;
  }>;
}): BookingSeriesDto {
  return {
    id: s.id,
    resource: { id: s.resource.id, name: s.resource.name },
    startTime: s.startTime,
    durationMinutes: s.durationMinutes,
    timezone: s.timezone,
    firstDate: isoDate(s.firstDate),
    lastDate: isoDate(s.lastDate),
    customer: { name: s.customerName, phone: s.customerPhone, userId: s.customerUserId },
    priceCents: s.priceCents,
    notes: s.notes,
    cancelledFrom: s.cancelledFrom ? isoDate(s.cancelledFrom) : null,
    createdAt: rfc3339(s.createdAt),
    occurrences: s.bookings.map((b) => ({
      bookingId: b.id,
      date: formatInTimeZone(b.startTs, s.timezone, 'yyyy-MM-dd'),
      startTs: rfc3339(b.startTs),
      endTs: rfc3339(b.endTs),
      status: b.status,
      totalCents: b.totalCents,
    })),
  };
}
