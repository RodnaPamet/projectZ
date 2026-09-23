import { type NextRequest } from 'next/server';

import {
  clampBookingLimit,
  getOwnBooking,
  getResourceForBooking,
  listOwnBookings,
} from '@/app-layer/repositories/booking';
import { quoteBooking } from '@/app-layer/usecases/availability';
import { createBooking } from '@/app-layer/usecases/booking';
import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toBooking } from '@/app/api/v1/_lib/dto';
import { ok, page } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Bookings for one club.
 *
 * ═══ THE PRICE IS NEVER THE CLIENT'S ═══
 *
 * `createBooking` takes `totalCents` and writes it down without opinion, which
 * is correct for a persistence concern and makes THIS the last place a price
 * can be decided. Forwarding a number from the request body would let anyone
 * book a €24 court for one cent, and nothing downstream would object: the
 * amount is perfectly valid, it is simply not the club's.
 *
 * So the body carries WHICH slot, never WHAT it costs. `quoteBooking` prices
 * it from the same windows and rules the availability endpoint used, so the
 * number the player was shown and the number they are charged come from one
 * implementation rather than two that agree today.
 *
 * ═══ IT DOES NOT CHECK WHETHER THE SLOT IS FREE ═══
 *
 * Deliberately, and the use case explains it at length: check-then-insert is
 * wrong under concurrency in a way tests do not reveal. The EXCLUDE constraint
 * arbitrates, and `SlotTakenError` becomes a 409 the client can retry from.
 * `quoteBooking` validates the shape of the request — open hours, step grid,
 * billable units — not the availability of the slot.
 */

interface CreateBody {
  resourceId?: unknown;
  startTs?: unknown;
  endTs?: unknown;
  notes?: unknown;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError(`\`${field}\` is required`, { field });
  }
  return v;
}

function requireInstant(v: unknown, field: string): Date {
  const d = new Date(requireString(v, field));
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`\`${field}\` must be an RFC 3339 timestamp`, { field });
  }
  return d;
}

async function listHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const limit = clampBookingLimit(Number(req.nextUrl.searchParams.get('limit')) || undefined);
  const cursor = req.nextUrl.searchParams.get('cursor');

  const { items, nextCursor } = await inTenant(ctx, (db) =>
    listOwnBookings(db, ctx.tenantId!, { userId: ctx.userId!, cursor, limit }),
  );

  // Own bookings only, enforced in the WHERE clause rather than filtered after
  // the read — see getOwnBooking. A club admin wanting every booking is a
  // different route with a different permission, not a flag on this one.
  return page(items.filter((b) => b !== null).map(toBooking), nextCursor);
}

async function createHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  // ═══ THE IDEMPOTENCY KEY IS REQUIRED, NOT GENERATED ═══
  //
  // Generating one server-side would make every retry a NEW booking, which is
  // the exact failure the key exists to prevent: the player taps once, the
  // network stalls, the app retries, and they are charged twice. Only the
  // client knows that two requests are the same tap.
  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    throw new ValidationError('An `Idempotency-Key` header is required', {
      field: 'Idempotency-Key',
    });
  }

  const body = (await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  })) as CreateBody;

  const resourceId = requireString(body.resourceId, 'resourceId');
  const startTs = requireInstant(body.startTs, 'startTs');
  const endTs = requireInstant(body.endTs, 'endTs');
  const notes = typeof body.notes === 'string' ? body.notes : null;

  const created = await inTenant(ctx, async (db) => {
    const resource = await getResourceForBooking(db, ctx.tenantId!, resourceId);

    // 404 covers "no such court" and "a court at another club" alike. RLS has
    // already made the second indistinguishable from the first, and saying
    // more would turn this into a probe for other clubs' resources.
    if (!resource || resource.venue.status !== 'ACTIVE') {
      throw new NotFoundError('Resource not found');
    }

    const quote = quoteBooking({
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
    });

    const result = await createBooking(db, ctx.tenantId!, {
      resourceId,
      startTs,
      endTs,
      totalCents: quote.priceCents,
      idempotencyKey,
      bookedByUserId: ctx.userId,
      notes,
    });

    const row = await getOwnBooking(db, ctx.tenantId!, {
      bookingId: result.bookingId,
      userId: ctx.userId!,
    });

    return { row, replay: result.idempotentReplay };
  });

  if (!created.row) throw new NotFoundError('Booking not found');

  // 200 on an idempotent replay, 201 on a genuine create. A client that
  // retried is not told it created something twice, and one that genuinely
  // created gets the status that says so.
  return ok(toBooking(created.row), { status: created.replay ? 200 : 201 });
}

export const GET = defineV1Route(listHandler);
export const POST = defineV1Route(createHandler);
