import type { BookingStatus, PrismaClient } from '@prisma/client';
import { fromZonedTime } from 'date-fns-tz';

import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { getResourceForBooking } from '@/app-layer/repositories/booking';
import { listPlayers } from '@/app-layer/repositories/player';
import type {
  CreateDeskBookingBody,
  CreateSeriesBody,
  DeskCustomer,
  DeskPreviewInput,
  UpdateDeskBookingBody,
} from '@/app-layer/schemas/desk';
import { appendAuditEntries, appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { normalizePhone } from '@/lib/booking/phone';
import {
  InvalidSeriesError,
  MAX_SERIES_WEEKS,
  resolveSpan,
  type Span,
  weeklyDates,
} from '@/lib/booking/weekly';

import { quoteBooking, SlotNotBookableError } from './availability';
import { cancelBooking, createBooking } from './booking';

/**
 * Desk bookings and weekly series (#364, owner decisions Q30 and Q41).
 *
 * The club's front desk enters a booking from the diary for a customer known by
 * NAME AND PHONE — a walk-in, a phone call, a regular — optionally linked to a
 * playerz account, and can repeat it every week. Every write here is staff
 * holding `bookings.view_all`; the routes enforce that, these functions assume
 * it.
 *
 * ═══ A DESK BOOKING IS AN ORDINARY BOOKING ═══
 *
 * Every booking, and every occurrence of a series, is written by `createBooking`
 * with `channel: 'DESK'`. So it is held by the same `booking_no_overlap`
 * constraint as an online booking — a desk booking and an online one can never
 * double-book a court, whichever lands first — and the diary, the player's own
 * list and a single cancel treat it like any other. What `DESK` changes is in
 * `createBooking`: no online cap, no no-show block, no "already started" rule,
 * and no club fee later (#372). Payment is at the club, so it is CONFIRMED at
 * once.
 *
 * ═══ THE CUSTOMER ═══
 *
 * `guestName` + `guestPhone` on the booking, ALWAYS — even when the booking is
 * linked to an account, because they are what the desk calls the customer and
 * what it rings. A link sets `bookedByUserId`, which is what puts the booking in
 * that player's Резервации. Only one of the CLUB'S players can be linked (see
 * `assertClubPlayer`), and matching by phone searches only them: whether a phone
 * belongs to somebody on playerz is never answered for a person who has not
 * played at this club.
 *
 * ═══ NOT CHECK-THEN-INSERT ═══
 *
 * `previewDesk` reads which weeks clash, to SHOW the desk. Creating never
 * trusts that read: it inserts every occurrence in one transaction and lets the
 * constraint arbitrate, so a booking that lands between the preview and the
 * create fails the whole series (409 SERIES_CLASH, with the weeks) rather than
 * double-booking one of them or leaving half a series behind.
 */

// ─── Errors ──────────────────────────────────────────────────────────

/** The linked account is not one of this club's players — or does not exist. */
export class DeskPlayerNotFoundError extends Error {
  constructor() {
    super('That player is not one of this club’s players.');
    this.name = 'DeskPlayerNotFoundError';
  }
}

/** The booking exists but was not made at the desk: its customer is an account. */
export class NotADeskBookingError extends Error {
  constructor() {
    super('Only a booking made at the desk can be edited here.');
    this.name = 'NotADeskBookingError';
  }
}

/** Cancelled, played or a no-show: its customer is history, not a live booking. */
export class DeskBookingNotEditableError extends Error {
  constructor(status: BookingStatus) {
    super(`A ${status.toLowerCase()} booking cannot be edited.`);
    this.name = 'DeskBookingNotEditableError';
  }
}

export interface SeriesClash {
  date: string;
  /** `taken`: another booking holds the court. `unavailable`: closed, or no such time that day. */
  reason: 'taken' | 'unavailable';
}

/**
 * Weeks of the series that cannot be booked as they are. Nothing was written:
 * the desk skips them (or changes the time) and sends the series again.
 */
export class SeriesClashError extends Error {
  constructor(readonly clashes: SeriesClash[]) {
    super(
      `${clashes.length} week(s) of the series clash: ${clashes.map((c) => c.date).join(', ')}.`,
    );
    this.name = 'SeriesClashError';
  }
}

// ─── Reads ───────────────────────────────────────────────────────────

type BookableResource = NonNullable<Awaited<ReturnType<typeof getResourceForBooking>>>;

/** The court, if it is this club's, ACTIVE, at an ACTIVE venue. */
export async function deskResource(
  db: PrismaClient,
  tenantId: string,
  resourceId: string,
): Promise<BookableResource | null> {
  const resource = await getResourceForBooking(db, tenantId, resourceId);
  if (!resource || resource.venue.status !== 'ACTIVE') return null;
  return resource;
}

/**
 * The server's price for a span, from the same windows and rules the player
 * route quotes with. Throws `SlotNotBookableError` for a span the club does not
 * offer (closed, off the step grid, too long).
 */
export function quoteSpan(resource: BookableResource, startTs: Date, endTs: Date): number {
  return quoteBooking({
    startTs,
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
}

/** The statuses that hold a court — `booking_no_overlap`'s own predicate. */
const OCCUPYING: BookingStatus[] = ['PENDING', 'CONFIRMED'];

/** Which of these spans another booking on the court already holds. */
async function takenDates(
  db: PrismaClient,
  tenantId: string,
  resourceId: string,
  spans: readonly Span[],
): Promise<Set<string>> {
  if (spans.length === 0) return new Set();
  const rows = await db.booking.findMany({
    where: {
      tenantId,
      resourceId,
      status: { in: OCCUPYING },
      OR: spans.map((s) => ({ startTs: { lt: s.endTs }, endTs: { gt: s.startTs } })),
    },
    select: { startTs: true, endTs: true },
    // A span of at most 12 h overlaps a bounded number of bookings; 20 per
    // week is far past any court's day.
    take: spans.length * 20,
  });
  const taken = new Set<string>();
  for (const s of spans) {
    if (rows.some((r) => r.startTs < s.endTs && r.endTs > s.startTs)) taken.add(s.date);
  }
  return taken;
}

export interface PreviewOccurrence {
  date: string;
  startTs: Date;
  endTs: Date;
  /** The server's quote; null when the slot is unavailable. */
  quotedCents: number | null;
  status: 'free' | 'taken' | 'unavailable';
}

/**
 * What the desk is about to book: each week's instants, the quote, and which
 * weeks clash. A READ, for the sheet — `createSeries` decides again, by
 * inserting.
 */
export async function previewDesk(
  db: PrismaClient,
  tenantId: string,
  body: DeskPreviewInput,
): Promise<{ resource: BookableResource; occurrences: PreviewOccurrence[] } | null> {
  const resource = await deskResource(db, tenantId, body.resourceId);
  if (!resource) return null;

  const spans = weeklyDates(body.date, body.repeat).map((d) =>
    resolveSpan(d, body.startTime, body.durationMinutes, resource.venue.timezone),
  );
  const taken = await takenDates(db, tenantId, resource.id, spans);

  const occurrences = spans.map((s): PreviewOccurrence => {
    let quotedCents: number | null = null;
    if (s.exists) {
      try {
        quotedCents = quoteSpan(resource, s.startTs, s.endTs);
      } catch (err) {
        if (!(err instanceof SlotNotBookableError)) throw err;
      }
    }
    const status = quotedCents === null ? 'unavailable' : taken.has(s.date) ? 'taken' : 'free';
    return { date: s.date, startTs: s.startTs, endTs: s.endTs, quotedCents, status };
  });

  return { resource, occurrences };
}

// ─── The customer ────────────────────────────────────────────────────

/**
 * Throws unless `userId` is one of THIS club's players: an ACTIVE PLAYER
 * membership here, a booking here under the account, or the club's own notes
 * on them. All three are tenant-scoped under RLS.
 *
 * Another club's player and an id that does not exist get the same refusal, so
 * the link cannot be used to probe who is on playerz.
 */
export async function assertClubPlayer(
  db: PrismaClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  const [membership, booking, notes] = await Promise.all([
    db.tenantMembership.findFirst({
      where: { tenantId, userId, role: 'PLAYER', status: 'ACTIVE' },
      select: { userId: true },
    }),
    db.booking.findFirst({
      where: { tenantId, bookedByUserId: userId },
      select: { id: true },
    }),
    db.playerVenueRelationship.findFirst({
      where: { tenantId, playerUserId: userId },
      select: { playerUserId: true },
    }),
  ]);
  if (!membership && !booking && !notes) throw new DeskPlayerNotFoundError();
}

export interface CustomerMatch {
  userId: string;
  name: string | null;
  email: string;
  matchedBy: 'phone' | 'name';
}

export const CUSTOMER_MATCH_LIMIT = 20;

/**
 * The club's players matching what the desk typed: a phone number, or part of
 * a name or email.
 *
 * ═══ ONLY THIS CLUB'S PLAYERS, EVER ═══
 *
 * The phone is compared against people this club already knows — its players'
 * own `User.phone`, and the phone on an earlier desk booking the club linked
 * to an account — never against every user. Searching all of playerz would
 * answer "is +359… on playerz?" for anybody, to staff of any club, which is
 * exactly the disclosure Q30 rules out. The phone itself is not returned.
 */
export async function findClubCustomers(
  db: PrismaClient,
  tenantId: string,
  query: string,
): Promise<CustomerMatch[]> {
  const q = query.trim();
  if (q === '') return [];

  const phone = normalizePhone(q);
  if (!phone) {
    const rows = await listPlayers(db, tenantId, { search: q });
    return rows.slice(0, CUSTOMER_MATCH_LIMIT).map((p) => ({
      userId: p.playerUserId,
      name: p.name,
      email: p.email,
      matchedBy: 'name',
    }));
  }

  // Step 1, the club's rows: its players, and its own earlier linked desk
  // bookings under this phone.
  const [players, linked] = await Promise.all([
    listPlayers(db, tenantId),
    db.booking.findMany({
      where: { tenantId, channel: 'DESK', guestPhone: phone, bookedByUserId: { not: null } },
      select: { bookedByUserId: true },
      distinct: ['bookedByUserId'],
      take: CUSTOMER_MATCH_LIMIT,
    }),
  ]);
  const byId = new Map(players.map((p) => [p.playerUserId, p]));

  // Step 2, by id, bounded by step 1: which of the club's players gave this
  // phone themselves. Stored as typed, so compared normalised.
  const users = byId.size
    ? await db.user.findMany({
        where: { id: { in: [...byId.keys()] }, phone: { not: null } },
        select: { id: true, phone: true },
        take: byId.size,
      })
    : [];

  const ids = new Set<string>();
  for (const u of users) if (u.phone && normalizePhone(u.phone) === phone) ids.add(u.id);
  for (const b of linked)
    if (b.bookedByUserId && byId.has(b.bookedByUserId)) ids.add(b.bookedByUserId);

  return [...ids].slice(0, CUSTOMER_MATCH_LIMIT).map((id) => {
    const p = byId.get(id)!;
    return { userId: id, name: p.name, email: p.email, matchedBy: 'phone' };
  });
}

// ─── Single desk booking ─────────────────────────────────────────────

export interface DeskWriteContext {
  tenantId: string;
  actorUserId: string;
  /** The client's retry key; namespaced here so it can never replay an online booking. */
  idempotencyKey: string;
  now?: Date;
}

const deskKey = (key: string) => `desk:${key}`;
const seriesKey = (key: string) => `series:${key}`;
const occurrenceKey = (key: string, date: string) => `series:${key}:${date}`;

/** Who the booking is for, as the booking row stores it. */
function customerColumns(customer: DeskCustomer) {
  return {
    guestName: customer.name,
    guestPhone: customer.phone,
    bookedByUserId: customer.userId ?? null,
  };
}

export async function createDeskBooking(
  db: PrismaClient,
  ctx: DeskWriteContext,
  body: CreateDeskBookingBody,
): Promise<{ bookingId: string; replay: boolean } | null> {
  const { tenantId } = ctx;
  const resource = await deskResource(db, tenantId, body.resourceId);
  if (!resource) return null;

  if (body.customer.userId) await assertClubPlayer(db, tenantId, body.customer.userId);

  const span = resolveSpan(
    body.date,
    body.startTime,
    body.durationMinutes,
    resource.venue.timezone,
  );
  if (!span.exists) throw new SlotNotBookableError('that time does not exist on that day');

  const quotedCents = quoteSpan(resource, span.startTs, span.endTs);
  const priceCents = body.priceCents ?? quotedCents;

  const created = await createBooking(db, tenantId, {
    resourceId: resource.id,
    startTs: span.startTs,
    endTs: span.endTs,
    totalCents: priceCents,
    idempotencyKey: deskKey(ctx.idempotencyKey),
    bookedByUserId: body.customer.userId ?? null,
    guestContact: { name: body.customer.name, phone: body.customer.phone },
    notes: body.notes ?? null,
    channel: 'DESK',
    onlinePayment: false,
    now: ctx.now,
  });

  // A replay made its audit rows the first time.
  if (created.idempotentReplay) return { bookingId: created.bookingId, replay: true };

  await appendAuditEntries(db, [
    {
      tenantId,
      actorUserId: ctx.actorUserId,
      entity: 'Booking',
      entityId: created.bookingId,
      action: AUDIT_ACTIONS.DESK_BOOKING_CREATED,
      details: 'Entered at the desk',
      detailsJson: {
        category: 'booking',
        summary: 'Staff entered a desk booking',
        resourceId: resource.id,
        startTs: span.startTs.toISOString(),
        endTs: span.endTs.toISOString(),
        customerName: body.customer.name,
        linkedUserId: body.customer.userId ?? null,
        priceCents,
      },
    },
    ...(priceCents !== quotedCents
      ? [
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            entity: 'Booking',
            entityId: created.bookingId,
            action: AUDIT_ACTIONS.DESK_PRICE_OVERRIDDEN,
            details: 'Price set at the desk',
            detailsJson: { category: 'booking', quotedCents, priceCents },
          },
        ]
      : []),
  ]);

  return { bookingId: created.bookingId, replay: false };
}

// ─── Detail and edit ─────────────────────────────────────────────────

const DESK_DETAIL_SELECT = {
  id: true,
  status: true,
  channel: true,
  startTs: true,
  endTs: true,
  totalCents: true,
  currency: true,
  notes: true,
  guestName: true,
  guestPhone: true,
  bookedByUserId: true,
  seriesId: true,
  cancelledAt: true,
  createdAt: true,
  resource: {
    select: { id: true, name: true, venue: { select: { id: true, name: true, timezone: true } } },
  },
  series: {
    select: {
      id: true,
      startTime: true,
      durationMinutes: true,
      firstDate: true,
      lastDate: true,
      cancelledFrom: true,
    },
  },
} as const;

/**
 * A desk booking, for its detail sheet. Null for an id that is not a DESK
 * booking at this club: an online booking's customer is an account, which this
 * screen does not edit, and saying "exists but is not yours to see here" would
 * be a probe.
 */
export async function getDeskBooking(db: PrismaClient, tenantId: string, bookingId: string) {
  const row = await db.booking.findFirst({
    where: { id: bookingId, tenantId, channel: 'DESK' },
    select: DESK_DETAIL_SELECT,
  });
  if (!row) return null;

  const [player, seriesLeft] = await Promise.all([
    row.bookedByUserId
      ? db.user.findUnique({
          where: { id: row.bookedByUserId },
          select: { id: true, name: true, email: true },
        })
      : null,
    row.seriesId
      ? db.booking.count({
          where: {
            tenantId,
            seriesId: row.seriesId,
            status: { in: OCCUPYING },
            startTs: { gte: row.startTs },
          },
        })
      : 0,
  ]);

  return { ...row, player, seriesLeft };
}

export type DeskBookingDetail = NonNullable<Awaited<ReturnType<typeof getDeskBooking>>>;

const LIVE: BookingStatus[] = ['PENDING', 'CONFIRMED'];

/**
 * Change a desk booking's customer or notes — this one, or with
 * `applyToSeries` this one and every later live occurrence of its series, and
 * the series itself.
 *
 * Only a live booking. Re-pointing a COMPLETED booking at another account
 * would hand that account a proof of visit it never made, and the review that
 * comes with it.
 */
export async function updateDeskBooking(
  db: PrismaClient,
  ctx: { tenantId: string; actorUserId: string },
  bookingId: string,
  body: UpdateDeskBookingBody,
): Promise<boolean> {
  const { tenantId } = ctx;
  const booking = await db.booking.findFirst({
    where: { id: bookingId, tenantId },
    select: {
      id: true,
      channel: true,
      status: true,
      startTs: true,
      seriesId: true,
      guestName: true,
      guestPhone: true,
      bookedByUserId: true,
      notes: true,
    },
  });
  if (!booking) return false;
  if (booking.channel !== 'DESK') throw new NotADeskBookingError();
  if (!LIVE.includes(booking.status)) throw new DeskBookingNotEditableError(booking.status);

  if (body.customer?.userId) await assertClubPlayer(db, tenantId, body.customer.userId);

  const data = {
    ...(body.customer ? customerColumns(body.customer) : {}),
    ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
  };

  const wholeSeries = !!(body.applyToSeries && booking.seriesId);
  let changed = 1;
  if (wholeSeries) {
    const updated = await db.booking.updateMany({
      where: {
        tenantId,
        seriesId: booking.seriesId!,
        status: { in: LIVE },
        startTs: { gte: booking.startTs },
      },
      data,
    });
    changed = updated.count;
    await db.bookingSeries.updateMany({
      where: { id: booking.seriesId!, tenantId },
      data: {
        ...(body.customer
          ? {
              customerName: body.customer.name,
              customerPhone: body.customer.phone,
              customerUserId: body.customer.userId ?? null,
            }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
      },
    });
  } else {
    // The status again in the predicate: a cancel between the read and here
    // leaves the cancelled booking as it was.
    const updated = await db.booking.updateMany({
      where: { id: booking.id, tenantId, status: { in: LIVE } },
      data,
    });
    if (updated.count === 0) throw new DeskBookingNotEditableError('CANCELLED');
  }

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: ctx.actorUserId,
    entity: wholeSeries ? 'BookingSeries' : 'Booking',
    entityId: wholeSeries ? booking.seriesId! : booking.id,
    action: AUDIT_ACTIONS.DESK_BOOKING_UPDATED,
    details: wholeSeries ? 'Desk series customer changed' : 'Desk booking changed',
    detailsJson: {
      category: 'booking',
      bookingId: booking.id,
      bookingsChanged: changed,
      before: {
        customerName: booking.guestName,
        linkedUserId: booking.bookedByUserId,
        notesChanged: body.notes !== undefined && body.notes !== booking.notes,
      },
      after: {
        customerName: body.customer?.name ?? booking.guestName,
        linkedUserId: body.customer ? (body.customer.userId ?? null) : booking.bookedByUserId,
      },
    },
  });

  return true;
}

// ─── Series ──────────────────────────────────────────────────────────

/**
 * Create a weekly series and every occurrence, in the caller's transaction.
 *
 * All or nothing. An occurrence that another booking takes between the
 * desk's preview and this INSERT raises `SlotTakenError` out of `createBooking`
 * and ABORTS the transaction, so the series row and the weeks before it roll
 * back with it. The route then reads which weeks clash, in a fresh
 * transaction (this one can run no more statements), and answers 409
 * SERIES_CLASH — see `seriesClashes`.
 *
 * Weeks the club is closed, or whose time the clocks skip, are refused up
 * front, before anything is written, as `unavailable` clashes.
 */
export async function createSeries(
  db: PrismaClient,
  ctx: DeskWriteContext,
  body: CreateSeriesBody,
): Promise<{ seriesId: string; replay: boolean } | null> {
  const { tenantId } = ctx;

  const replay = await db.bookingSeries.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: seriesKey(ctx.idempotencyKey) } },
    select: { id: true },
  });
  if (replay) return { seriesId: replay.id, replay: true };

  const resource = await deskResource(db, tenantId, body.resourceId);
  if (!resource) return null;

  if (body.customer.userId) await assertClubPlayer(db, tenantId, body.customer.userId);

  const tz = resource.venue.timezone;
  const all = weeklyDates(body.date, body.repeat);
  const skip = new Set(body.skipDates ?? []);
  const spans = all
    .filter((d) => !skip.has(d))
    .map((d) => resolveSpan(d, body.startTime, body.durationMinutes, tz));
  if (spans.length === 0) throw new InvalidSeriesError('every week was skipped');

  const quotes = new Map<string, number>();
  const unavailable: SeriesClash[] = [];
  for (const s of spans) {
    try {
      if (!s.exists) throw new SlotNotBookableError('that time does not exist on that day');
      quotes.set(s.date, quoteSpan(resource, s.startTs, s.endTs));
    } catch (err) {
      if (!(err instanceof SlotNotBookableError)) throw err;
      unavailable.push({ date: s.date, reason: 'unavailable' });
    }
  }
  if (unavailable.length > 0) throw new SeriesClashError(unavailable);

  const series = await db.bookingSeries.create({
    data: {
      tenantId,
      resourceId: resource.id,
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      timezone: tz,
      firstDate: new Date(`${spans[0]!.date}T00:00:00Z`),
      lastDate: new Date(`${spans[spans.length - 1]!.date}T00:00:00Z`),
      customerName: body.customer.name,
      customerPhone: body.customer.phone,
      customerUserId: body.customer.userId ?? null,
      priceCents: body.priceCents ?? null,
      notes: body.notes ?? null,
      createdByUserId: ctx.actorUserId,
      idempotencyKey: seriesKey(ctx.idempotencyKey),
    },
    select: { id: true },
  });

  // In date order, every time: two series racing for the same weeks then
  // meet on the same first contested week, and one waits for the other rather
  // than each holding a week the other needs.
  const bookingIds: string[] = [];
  for (const s of spans) {
    const created = await createBooking(db, tenantId, {
      resourceId: resource.id,
      startTs: s.startTs,
      endTs: s.endTs,
      totalCents: body.priceCents ?? quotes.get(s.date)!,
      idempotencyKey: occurrenceKey(ctx.idempotencyKey, s.date),
      bookedByUserId: body.customer.userId ?? null,
      guestContact: { name: body.customer.name, phone: body.customer.phone },
      notes: body.notes ?? null,
      channel: 'DESK',
      onlinePayment: false,
      seriesId: series.id,
      now: ctx.now,
    });
    bookingIds.push(created.bookingId);
  }

  const quotedValues = [...quotes.values()];
  const overridden = body.priceCents != null && quotedValues.some((q) => q !== body.priceCents);

  await appendAuditEntries(db, [
    {
      tenantId,
      actorUserId: ctx.actorUserId,
      entity: 'BookingSeries',
      entityId: series.id,
      action: AUDIT_ACTIONS.BOOKING_SERIES_CREATED,
      details: 'Weekly series entered at the desk',
      detailsJson: {
        category: 'booking',
        summary: 'Staff created a weekly series',
        resourceId: resource.id,
        startTime: body.startTime,
        durationMinutes: body.durationMinutes,
        timezone: tz,
        dates: spans.map((s) => s.date),
        skipped: all.filter((d) => skip.has(d)),
        customerName: body.customer.name,
        linkedUserId: body.customer.userId ?? null,
        priceCents: body.priceCents ?? null,
        bookingIds,
      },
    },
    ...(overridden
      ? [
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            entity: 'BookingSeries',
            entityId: series.id,
            action: AUDIT_ACTIONS.DESK_PRICE_OVERRIDDEN,
            details: 'Series price set at the desk',
            detailsJson: {
              category: 'booking',
              priceCents: body.priceCents!,
              quotedCents: Object.fromEntries(quotes),
            },
          },
        ]
      : []),
  ]);

  return { seriesId: series.id, replay: false };
}

/**
 * After a series create lost a race: which of its weeks are now held by
 * another booking. Run in a FRESH transaction — the failed one is aborted.
 */
export async function seriesClashes(
  db: PrismaClient,
  tenantId: string,
  body: CreateSeriesBody,
): Promise<SeriesClash[]> {
  const resource = await deskResource(db, tenantId, body.resourceId);
  if (!resource) return [];
  const skip = new Set(body.skipDates ?? []);
  const spans = weeklyDates(body.date, body.repeat)
    .filter((d) => !skip.has(d))
    .map((d) => resolveSpan(d, body.startTime, body.durationMinutes, resource.venue.timezone));
  const taken = await takenDates(db, tenantId, resource.id, spans);
  return spans.filter((s) => taken.has(s.date)).map((s) => ({ date: s.date, reason: 'taken' }));
}

/** A series and its occurrences, for the detail sheet. */
export async function getSeries(db: PrismaClient, tenantId: string, seriesId: string) {
  return db.bookingSeries.findFirst({
    where: { id: seriesId, tenantId },
    select: {
      id: true,
      resourceId: true,
      startTime: true,
      durationMinutes: true,
      timezone: true,
      firstDate: true,
      lastDate: true,
      customerName: true,
      customerPhone: true,
      customerUserId: true,
      priceCents: true,
      notes: true,
      cancelledFrom: true,
      createdAt: true,
      resource: { select: { id: true, name: true } },
      bookings: {
        select: { id: true, startTs: true, endTs: true, status: true, totalCents: true },
        orderBy: { startTs: 'asc' },
        take: MAX_SERIES_WEEKS,
      },
    },
  });
}

export type SeriesDetail = NonNullable<Awaited<ReturnType<typeof getSeries>>>;

/**
 * "Cancel the rest": every live occurrence starting on or after `fromDate` at
 * the club, each through `cancelBooking` as the desk — the same receipt and
 * the same BOOKING_CANCELLED audit row a single cancel writes — plus one row
 * for the series. Occurrences already played or cancelled are left alone.
 *
 * Run it SERIALIZABLE, as the cancel route does: `cancelBooking`'s wallet leg
 * requires it.
 */
export async function cancelSeriesFrom(
  db: PrismaClient,
  ctx: { tenantId: string; actorUserId: string; now?: Date },
  seriesId: string,
  input: { fromDate: string; reason?: string },
): Promise<{ cancelledBookingIds: string[] } | null> {
  const { tenantId } = ctx;
  const series = await db.bookingSeries.findFirst({
    where: { id: seriesId, tenantId },
    select: { id: true, timezone: true, cancelledFrom: true },
  });
  if (!series) return null;

  const from = fromZonedTime(`${input.fromDate}T00:00:00`, series.timezone);
  const live = await db.booking.findMany({
    where: { tenantId, seriesId: series.id, status: { in: LIVE }, startTs: { gte: from } },
    select: { id: true },
    orderBy: { startTs: 'asc' },
    take: MAX_SERIES_WEEKS,
  });

  for (const b of live) {
    await cancelBooking(db, tenantId, {
      bookingId: b.id,
      actor: 'STAFF',
      cancelledByUserId: ctx.actorUserId,
      reason: input.reason ?? 'Series cancelled from this date',
      now: ctx.now,
    });
  }

  const cut = new Date(`${input.fromDate}T00:00:00Z`);
  if (!series.cancelledFrom || cut < series.cancelledFrom) {
    await db.bookingSeries.updateMany({
      where: { id: series.id, tenantId },
      data: { cancelledFrom: cut },
    });
  }

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: ctx.actorUserId,
    entity: 'BookingSeries',
    entityId: series.id,
    action: AUDIT_ACTIONS.BOOKING_SERIES_CANCELLED,
    details: 'Series cancelled from a date',
    detailsJson: {
      category: 'booking',
      fromDate: input.fromDate,
      cancelledBookingIds: live.map((b) => b.id),
    },
  });

  return { cancelledBookingIds: live.map((b) => b.id) };
}
