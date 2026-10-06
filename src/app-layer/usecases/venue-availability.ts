import type { PrismaClient } from '@prisma/client';

import {
  getAvailabilityInputs,
  minutesFromTimeColumn,
  type PublicVenue,
} from '@/app-layer/repositories/availability';

import { computeSlots, slotDurations, type DurationOption, type Slot } from './availability';

/**
 * One venue's bookable slots over a window, each free slot with the lengths it
 * can be booked for and their prices.
 *
 * ═══ ONE IMPLEMENTATION FOR THE ROUTE AND THE PAGE ═══
 *
 * `GET /api/v1/venues/{id}/availability` answers the native app and the venue
 * page's later days (through SWR); the venue page (#355) renders its first day
 * on the server. If the two were computed by two copies of this loop, the first
 * revalidation could swap one grid for another under the player's thumb. Both
 * call this, and both map the result with `toAvailability`.
 *
 * The caller binds the handle: the venue is public and cross-tenant, so both
 * callers use BYPASSRLS with `status: ACTIVE` as the filter (see the route).
 */
export interface VenueAvailabilityResource {
  resource: {
    id: string;
    name: string;
    sport: string;
    currency: string;
    minBookingMinutes: number;
    maxBookingMinutes: number;
    slotStepMinutes: number;
  };
  slots: Array<Slot & { durations?: DurationOption[] }>;
}

export async function loadVenueAvailability(
  db: PrismaClient,
  opts: { venue: PublicVenue; from: Date; to: Date; resourceId?: string | null },
): Promise<VenueAvailabilityResource[]> {
  const inputs = await getAvailabilityInputs(db, opts);

  return inputs.resources.map((resource) => {
    const booked = inputs.bookings.filter((b) => b.resourceId === resource.id);
    const windows = resource.availability.map((w) => ({
      dayOfWeek: w.dayOfWeek,
      // `openTime`/`closeTime` are `time` columns: a Date pinned to 1970-01-01
      // UTC. The wall clock lives in the UTC accessors and nowhere else — see
      // minutesFromTimeColumn.
      openMinutes: minutesFromTimeColumn(w.openTime),
      closeMinutes: minutesFromTimeColumn(w.closeTime),
      effectiveFrom: w.effectiveFrom,
      effectiveTo: w.effectiveTo,
      exceptionDate: w.exceptionDate,
    }));
    const pricingRules = resource.pricingRules.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      conditionsJson: r.conditionsJson as never,
      multiplier: r.multiplier as never,
      fixedPriceCents: r.fixedPriceCents,
    }));

    // RangeTooWideError escapes to the caller; the route maps it to 400
    // RANGE_TOO_WIDE. `resolveAvailabilityRange` has already applied the same
    // ceiling, because the booking query above runs first.
    const slots = computeSlots({
      from: opts.from,
      to: opts.to,
      timezone: opts.venue.timezone,
      slotStepMinutes: resource.slotStepMinutes,
      minBookingMinutes: resource.minBookingMinutes,
      basePriceCents: resource.basePriceCents,
      windows,
      booked,
      pricingRules,
    });

    return {
      resource,
      slots: slots.map((slot) =>
        slot.available
          ? {
              ...slot,
              durations: slotDurations(slot.startTs, {
                timezone: opts.venue.timezone,
                windows,
                basePriceCents: resource.basePriceCents,
                minBookingMinutes: resource.minBookingMinutes,
                maxBookingMinutes: resource.maxBookingMinutes,
                slotStepMinutes: resource.slotStepMinutes,
                booked,
                pricingRules,
              }),
            }
          : slot,
      ),
    };
  });
}
