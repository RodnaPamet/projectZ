import { type NextRequest } from 'next/server';

import {
  clampBookingLimit,
  getOwnBooking,
  getResourceForBooking,
  listOwnBookings,
} from '@/app-layer/repositories/booking';
import { createBookingBodySchema } from '@/app-layer/schemas/booking';
import { quoteBooking } from '@/app-layer/usecases/availability';
import { createBooking } from '@/app-layer/usecases/booking';
import { notifyBookingConfirmed } from '@/app-layer/usecases/booking-notifications';
import { clubTakesOnlinePayment } from '@/app-layer/usecases/booking-rules';
import { resolvePlayerTenant } from '@/app-layer/usecases/club-membership';
import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toBooking } from '@/app/api/v1/_lib/dto';
import { ok, page } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { countUsage } from '@/lib/usage/record';

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

/**
 * The body, through `createBookingBodySchema` (#354): RFC 3339 instants, a
 * capped `notes`, unknown keys ignored. The first issue names the field, as the
 * hand-rolled checks this replaced did, and every issue rides in `details`.
 */
function parseCreateBody(raw: unknown) {
  const parsed = createBookingBodySchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  const field = first?.path.join('.') || 'body';
  throw new ValidationError(`\`${field}\`: ${first?.message ?? 'invalid'}`, {
    field,
    issues: parsed.error.issues,
  });
}

async function listHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const limit = clampBookingLimit(Number(req.nextUrl.searchParams.get('limit')) || undefined);
  const cursor = req.nextUrl.searchParams.get('cursor');

  // Resolved against the DATABASE, not the token — as `contextFromRequest`
  // now does too (#250). This resolver is used rather than `ctx.tenantId`
  // because it also answers "is the club ACTIVE", which the context does not.
  // `createIfAbsent: false`: listing must never join.
  const standing = await resolvePlayerTenant(ctx.userId, slug, { createIfAbsent: false });

  // No standing, no bookings. An empty page rather than a 403: whether you are
  // a member of a club is not something this endpoint should confirm, and the
  // answer you get is the same one a member with no bookings gets.
  if (!standing) return page([], null);

  const { items, nextCursor } = await inTenant({ ...ctx, tenantId: standing.tenantId }, (db) =>
    listOwnBookings(db, standing.tenantId, { userId: ctx.userId!, cursor, limit }),
  );

  // Own bookings only, enforced in the WHERE clause rather than filtered after
  // the read — see getOwnBooking. A club admin wanting every booking is a
  // different route with a different permission, not a flag on this one.
  return page(items.filter((b) => b !== null).map(toBooking), nextCursor);
}

async function createHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // `joinsAsPlayer`: the one tenant route a NON-member may reach, because
  // booking is how a player joins a club (#229). A member is still checked
  // against the permission table from the database; a non-member gets a
  // context with no tenant and no permissions, and is joined below — after the
  // request has been validated — or refused with the same 404 as an unknown
  // club.
  const ctx = await contextFromRequest(req, {
    slug,
    requestId: getRequestId(),
    joinsAsPlayer: true,
  });

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

  const body = parseCreateBody(
    await req.json().catch(() => {
      throw new ValidationError('Body must be JSON');
    }),
  );

  const resourceId = body.resourceId;
  const startTs = new Date(body.startTs);
  const endTs = new Date(body.endTs);
  const notes = body.notes ? body.notes : null;

  // ═══ A SIGNED-IN PLAYER MAY BOOK AT ANY ACTIVE CLUB ═══
  //
  // Owner's decision. Until now the only writer of TenantMembership was
  // `acceptInvite`, so booking required the club to have invited you by email
  // — while `/venues` listed every club publicly. The API refused what the
  // catalogue advertised.
  //
  // The membership is created rather than bypassed. Binding a tenant the
  // caller has no membership for would put a hole in the one mechanism that
  // stops a stale membership becoming authority at the wrong club.
  const standing = await resolvePlayerTenant(ctx.userId, slug, { createIfAbsent: true });

  // Same 404 as an unknown court, and for the same reason: distinguishing
  // "no such club" from "suspended" or "you are banned here" turns this into
  // a probe.
  if (!standing) throw new NotFoundError('Resource not found');

  const tenantId = standing.tenantId;

  const created = await inTenant({ ...ctx, tenantId }, async (db) => {
    const resource = await getResourceForBooking(db, tenantId, resourceId);

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

    // CONFIRMED at once and paid at the club, unless this club takes payment
    // online — none does in the Sofia pilot (#354). A slot that has started
    // (400 SLOT_NOT_BOOKABLE) and a player with three recent no-shows here
    // (403 NO_SHOW_BLOCKED) are refused inside `createBooking`, AFTER the
    // idempotent replay, so a retry still returns the booking it made.
    const onlinePayment = await clubTakesOnlinePayment(db, tenantId);

    const result = await createBooking(db, tenantId, {
      resourceId,
      startTs,
      endTs,
      totalCents: quote.priceCents,
      idempotencyKey,
      bookedByUserId: ctx.userId,
      notes,
      onlinePayment,
    });

    const row = await getOwnBooking(db, tenantId, {
      bookingId: result.bookingId,
      userId: ctx.userId!,
    });

    return { row, replay: result.idempotentReplay, venueId: resource.venue.id };
  });

  if (!created.row) throw new NotFoundError('Booking not found');

  // After the commit (#367): the bell, and the confirmation email through the
  // outbox. Only a genuine create; a replay was announced the first time, and
  // the dedupe key would refuse a second one anyway. Never throws.
  if (!created.replay) {
    await notifyBookingConfirmed({ tenantId, bookingId: created.row.id });
    // The funnel's last step (#371): a count, no booking id, no booker.
    countUsage(
      'BOOKING_CREATED',
      { venueId: created.venueId },
      { userAgent: req.headers.get('user-agent') },
    );
  }

  // 200 on an idempotent replay, 201 on a genuine create. A client that
  // retried is not told it created something twice, and one that genuinely
  // created gets the status that says so.
  return ok(toBooking(created.row), { status: created.replay ? 200 : 201 });
}

export const GET = defineV1Route(listHandler);
export const POST = defineV1Route(createHandler);
