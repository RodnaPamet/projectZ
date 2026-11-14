import type { SportType } from '@prisma/client';

import { getPublicVenue, type PublicVenue } from '@/app-layer/repositories/availability';
import { nearVenueIds } from '@/app-layer/repositories/geo';
import { listVenues, listVenuesByIds } from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import {
  cheapestPerStart,
  clockOf,
  daySpan,
  freeHourlyStarts,
  isLocalDate,
  localDayRange,
} from '@/lib/assistant/slots';

import { loadVenueAvailability } from './venue-availability';

/**
 * `find_free_places` (owner 2026-11-14, #704): free bookable hours with
 * prices, for a sport, in a city or near the person, over a few days.
 *
 * Read exactly as `GET /venues/{id}/availability` reads them — public,
 * cross-club, BYPASSRLS with `publicVenueFilter` as the filter (inside the
 * repositories) — and through the same `loadVenueAvailability`, so the
 * assistant cannot offer an hour the app would not. What leaks is what a club
 * publishes: hours, prices, which are taken; never who took them.
 */

/** At most this many clubs are read for one question. */
export const MAX_VENUES = 6;
/** At most this many hours go back to the model. */
export const MAX_RESULTS = 24;
/** At most this many days per search. */
export const MAX_DAYS = 7;
/** Near the person, unless they say otherwise. */
export const DEFAULT_RADIUS_KM = 15;

export interface FindPlacesInput {
  sport: SportType;
  dateFrom: string;
  dateTo: string;
  timeFrom?: string;
  timeTo?: string;
  minutes?: number;
  city?: string;
  near?: boolean;
  radiusKm?: number;
  venueId?: string;
}

export interface FindPlacesContext {
  now: Date;
  /** Where the app says the person is; never shown to the model. */
  location?: { lat: number; lng: number } | null;
}

export class FindPlacesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindPlacesInputError';
  }
}

export interface FreePlace {
  venueId: string;
  venue: string;
  city: string;
  distanceKm?: number;
  resourceId: string;
  court: string;
  startTs: string;
  endTs: string;
  /** The club's own clock, for the answer: `2026-11-15 Sat 18:00`. */
  local: string;
  minutes: number;
  priceCents: number;
  currency: string;
}

export interface FindPlacesResult {
  places: FreePlace[];
  venuesSearched: number;
  moreAvailable: boolean;
}

interface VenueRow {
  id: string;
  name: string;
  city: string;
  timezone: string;
  distanceKm?: number;
}

export async function findFreePlaces(
  input: FindPlacesInput,
  ctx: FindPlacesContext,
): Promise<FindPlacesResult> {
  if (!isLocalDate(input.dateFrom) || !isLocalDate(input.dateTo)) {
    throw new FindPlacesInputError('dateFrom and dateTo must be YYYY-MM-DD');
  }
  const span = daySpan(input.dateFrom, input.dateTo);
  if (span < 1) throw new FindPlacesInputError('dateTo is before dateFrom');
  if (span > MAX_DAYS) throw new FindPlacesInputError(`at most ${MAX_DAYS} days at a time`);
  if (input.near && !ctx.location) {
    throw new FindPlacesInputError(
      'the app did not send the person’s location: ask for a city, or for them to allow location',
    );
  }
  if (!input.venueId && !input.city && !input.near) {
    throw new FindPlacesInputError('say where: a city, near the person, or a club');
  }

  return runAsSuperuser(async (db) => {
    let venues: VenueRow[];
    if (input.venueId) {
      const v = await getPublicVenue(db, input.venueId);
      const card = v ? await listVenuesByIds(db, [v.id], { sport: input.sport }) : [];
      venues = card.map((c) => ({ id: c.id, name: c.name, city: c.city, timezone: c.timezone }));
    } else if (input.near && ctx.location) {
      const near = await nearVenueIds(db, {
        lat: ctx.location.lat,
        lng: ctx.location.lng,
        radiusKm: input.radiusKm ?? DEFAULT_RADIUS_KM,
      });
      const distance = new Map(near.map((n) => [n.id, n.distanceKm]));
      const rows = await listVenuesByIds(db, [...distance.keys()], {
        sport: input.sport,
        ...(input.city ? { city: input.city } : {}),
      });
      venues = rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          city: r.city,
          timezone: r.timezone,
          distanceKm: distance.get(r.id)!,
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, MAX_VENUES);
    } else {
      const page = await listVenues(
        db,
        { sport: input.sport, city: input.city },
        { limit: MAX_VENUES },
      );
      venues = page.items.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        timezone: r.timezone,
      }));
    }

    const places: FreePlace[] = [];
    for (const v of venues) {
      const publicVenue: PublicVenue = { id: v.id, name: v.name, timezone: v.timezone };
      const { from, to } = localDayRange(input.dateFrom, input.dateTo, v.timezone);
      // guardrail-allow: n-plus-one — at most MAX_VENUES clubs, each one
      // availability read, the same two queries the venue page makes.
      const resources = await loadVenueAvailability(db, { venue: publicVenue, from, to });
      const starts = resources
        .filter((r) => r.resource.sport === input.sport)
        .flatMap((r) =>
          freeHourlyStarts(r, {
            now: ctx.now,
            timeZone: v.timezone,
            ...(input.minutes ? { minutes: input.minutes } : {}),
            ...(input.timeFrom ? { timeFrom: input.timeFrom } : {}),
            ...(input.timeTo ? { timeTo: input.timeTo } : {}),
          }),
        );
      const byId = new Map(resources.map((r) => [r.resource.id, r.resource]));
      for (const s of cheapestPerStart(starts)) {
        const court = byId.get(s.resourceId)!;
        const c = clockOf(s.startTs, v.timezone);
        places.push({
          venueId: v.id,
          venue: v.name,
          city: v.city,
          ...(v.distanceKm !== undefined ? { distanceKm: Math.round(v.distanceKm * 10) / 10 } : {}),
          resourceId: s.resourceId,
          court: court.name,
          startTs: s.startTs.toISOString(),
          endTs: s.endTs.toISOString(),
          local: `${c.date} ${c.weekday} ${c.time}`,
          minutes: s.minutes,
          priceCents: s.priceCents,
          currency: court.currency,
        });
      }
    }

    places.sort(
      (a, b) => Date.parse(a.startTs) - Date.parse(b.startTs) || a.priceCents - b.priceCents,
    );
    return {
      places: places.slice(0, MAX_RESULTS),
      venuesSearched: venues.length,
      moreAvailable: places.length > MAX_RESULTS,
    };
  });
}

/**
 * Is this exact hour still free and bookable at the club? For a proposal the
 * model makes from an option it was shown earlier: the hour is read again,
 * as the app would read it, before it becomes a draft.
 */
export async function isStillFree(
  input: { venueId: string; resourceId: string; startTs: Date; endTs: Date },
  now: Date,
): Promise<boolean> {
  return runAsSuperuser(async (db) => {
    const venue = await getPublicVenue(db, input.venueId);
    if (!venue) return false;
    const resources = await loadVenueAvailability(db, {
      venue,
      resourceId: input.resourceId,
      from: input.startTs,
      to: input.endTs,
    });
    const r = resources.find((x) => x.resource.id === input.resourceId);
    if (!r) return false;
    const minutes = Math.round((input.endTs.getTime() - input.startTs.getTime()) / 60_000);
    return freeHourlyStarts(r, { now, timeZone: venue.timezone, minutes }).some(
      (s) =>
        s.startTs.getTime() === input.startTs.getTime() &&
        s.endTs.getTime() === input.endTs.getTime(),
    );
  });
}
