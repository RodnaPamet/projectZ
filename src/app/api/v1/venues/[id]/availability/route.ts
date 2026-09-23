import { type NextRequest } from 'next/server';

import {
  getAvailabilityInputs,
  getPublicVenue,
  minutesFromTimeColumn,
} from '@/app-layer/repositories/availability';
import { computeSlots } from '@/app-layer/usecases/availability';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toAvailability } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { resolveAvailabilityRange } from '@/app/api/v1/_lib/range';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Bookable slots for a venue. Cross-tenant, unauthenticated.
 *
 * ═══ WHY THIS IS PUBLIC, AND NOT UNDER /t/{slug}/ ═══
 *
 * The tenant-scoped surface is gated by `checkTenantAccess`, which requires
 * MEMBERSHIP of the club in the path. Putting availability there would mean a
 * player can only see free courts at clubs they have already joined — which
 * makes booking at a new club impossible, and this is a marketplace.
 *
 * So it sits beside `/api/v1/venues/{id}`, which is public for the same
 * reason, and carries the same protections: BYPASSRLS with `status: ACTIVE` as
 * the filter, and a hand-written DTO. What leaks is what a club publishes —
 * opening hours, prices, and which slots are taken. Never WHO took them: the
 * booking query selects three columns and the booker is not among them.
 *
 * ═══ PENDING BOOKINGS BLOCK, AND NOTHING SWEEPS THEM ═══
 *
 * `SLOT_HOLDING_STATUSES` mirrors the `booking_no_overlap` exclusion
 * constraint, which counts PENDING as occupying the slot. `Booking.expiresAt`
 * exists to bound that, but nothing in the repository currently acts on it —
 * there is no sweeper and no job registered to cancel an expired PENDING.
 *
 * This route deliberately does NOT filter expired PENDINGs out. Doing so would
 * make it offer a slot whose INSERT the database then rejects, which surfaces
 * to the player as a random failure at the last step of checkout. Until the
 * sweeper exists, an abandoned checkout holds its slot, and that is visible
 * here rather than hidden.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  const venue = await asSuperuser(ctx, (db) => getPublicVenue(db, id));

  // 404 before the range is even parsed. A bad date on a venue that does not
  // exist should say the venue does not exist — reporting the date first sends
  // the client chasing the wrong problem.
  if (!venue) throw new NotFoundError('Venue not found');

  const { from, to } = resolveAvailabilityRange(req.nextUrl.searchParams, venue.timezone);
  const resourceId = req.nextUrl.searchParams.get('resourceId');

  const inputs = await asSuperuser(ctx, (db) =>
    getAvailabilityInputs(db, { venue, resourceId, from, to }),
  );

  const resources = inputs.resources.map((resource) => {
    const booked = inputs.bookings.filter((b) => b.resourceId === resource.id);

    return {
      resource,
      // RangeTooWideError escapes to defineV1Route, which maps it to
      // 400 RANGE_TOO_WIDE via DOMAIN_ERROR_MAP. It is the use case's ceiling,
      // not this route's, so it is not duplicated here.
      slots: computeSlots({
        from,
        to,
        timezone: venue.timezone,
        slotStepMinutes: resource.slotStepMinutes,
        minBookingMinutes: resource.minBookingMinutes,
        basePriceCents: resource.basePriceCents,
        windows: resource.availability.map((w) => ({
          dayOfWeek: w.dayOfWeek,
          // `openTime`/`closeTime` are `time` columns: a Date pinned to
          // 1970-01-01 UTC. The wall clock lives in the UTC accessors and
          // nowhere else — see minutesFromTimeColumn.
          openMinutes: minutesFromTimeColumn(w.openTime),
          closeMinutes: minutesFromTimeColumn(w.closeTime),
          effectiveFrom: w.effectiveFrom,
          effectiveTo: w.effectiveTo,
          exceptionDate: w.exceptionDate,
        })),
        booked,
        pricingRules: resource.pricingRules.map((r) => ({
          id: r.id,
          name: r.name,
          priority: r.priority,
          conditionsJson: r.conditionsJson as never,
          multiplier: r.multiplier as never,
          fixedPriceCents: r.fixedPriceCents,
        })),
      }),
    };
  });

  return ok(toAvailability({ venue, from, to, resources }));
}

export const GET = defineV1Route(handler);
