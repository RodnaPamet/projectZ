import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import { allowedMinutes, offersFor, type Offer } from '@/lib/booking/offers';

/**
 * Time first, then the plan (#625, owner 2026-10-20): the player picks a start
 * and a length, and the plan shows which courts are free for exactly that.
 * The same offers the list shows (`offersFor`), so the plan and the list can
 * never disagree about a court.
 */

/** Every length any of the courts allows, shortest first. */
export function planLengths(courts: ResourceSlotsDto[]): number[] {
  return [...new Set(courts.flatMap(allowedMinutes))].sort((a, b) => a - b);
}

/** Every start at which at least one court is free for `minutes`, earliest first. */
export function planTimes(courts: ResourceSlotsDto[], minutes: number, now: number): string[] {
  const starts = new Set(courts.flatMap((r) => offersFor(r, minutes, now).map((o) => o.startTs)));
  return [...starts].sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** A court at the picked time: free with its offer, or not. */
export type CourtAtTime = { free: true; offer: Offer } | { free: false };

export function courtAt(
  court: ResourceSlotsDto,
  minutes: number,
  startTs: string | null,
  now: number,
): CourtAtTime {
  const offer = startTs
    ? offersFor(court, minutes, now).find((o) => o.startTs === startTs)
    : undefined;
  return offer ? { free: true, offer } : { free: false };
}

/**
 * A taken court's next free starts after `startTs`: for the picked length when
 * the court allows it, else for its own shortest.
 */
export function laterOffers(
  court: ResourceSlotsDto,
  minutes: number,
  startTs: string | null,
  now: number,
  limit = 3,
): Offer[] {
  const length = allowedMinutes(court).includes(minutes) ? minutes : court.minBookingMinutes;
  const after = startTs ? Date.parse(startTs) : now;
  return offersFor(court, length, now)
    .filter((o) => Date.parse(o.startTs) > after)
    .slice(0, limit);
}
