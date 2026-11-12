import { listVenuesByIds } from '@/app-layer/repositories/venue';
import { toSummaries } from '@/app/api/v1/_lib/venue-summaries';
import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * Favourite clubs (#672, owner decision 2026-11-12): the heart on a venue
 * card and «Любими» on the phone and the web.
 *
 * The rows are the person's own (owner-only RLS, P87), read and written as
 * them. The cards are public venue data and go through the public venue
 * filter, as /venues does, so a club that is suspended or gone drops out of
 * «Любими» without anything to clean up.
 */

/** Enough for anyone; a cap so a script cannot grow one person's list without end. */
export const MAX_FAVOURITE_VENUES = 200;

export class FavouriteVenueNotFoundError extends Error {
  constructor() {
    super('Venue not found');
    this.name = 'FavouriteVenueNotFoundError';
  }
}

export class TooManyFavouritesError extends Error {
  constructor() {
    super(`At most ${MAX_FAVOURITE_VENUES} favourite venues`);
    this.name = 'TooManyFavouritesError';
  }
}

/** The person's favourite venue ids, newest first. */
export async function myFavouriteVenueIds(userId: string): Promise<string[]> {
  const rows = await runAsUserOnly(userId, (db) =>
    // guardrail-allow: cross-tenant — the person's own hearts, by their session id.
    db.favouriteVenue.findMany({
      where: { userId },
      select: { venueId: true },
      orderBy: [{ createdAt: 'desc' }, { venueId: 'asc' }],
      take: MAX_FAVOURITE_VENUES,
    }),
  );
  return rows.map((r) => r.venueId);
}

/** Their cards, in the order the hearts were given; a venue no longer public is left out. */
export async function myFavouriteVenues(
  userId: string,
): Promise<{ ids: string[]; items: VenueSummary[] }> {
  const ids = await myFavouriteVenueIds(userId);
  // guardrail-allow: cross-tenant — public venue cards for ids the person chose,
  // through publicVenueFilter like the venue index.
  const cards = await runAsSuperuser(async (db) =>
    toSummaries(db, await listVenuesByIds(db, ids, {})),
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  const items = cards.sort((a, z) => (order.get(a.id) ?? 0) - (order.get(z.id) ?? 0));
  return { ids: items.map((v) => v.id), items };
}

/** Heart on or off. Idempotent; only a public venue can be hearted. */
export async function setFavouriteVenue(input: {
  userId: string;
  venueId: string;
  favourite: boolean;
}): Promise<{ favourite: boolean }> {
  if (input.favourite) {
    // guardrail-allow: cross-tenant — is this a public venue: the venue index's filter.
    const found = await runAsSuperuser((db) => listVenuesByIds(db, [input.venueId], {}));
    if (found.length === 0) throw new FavouriteVenueNotFoundError();
  }
  return runAsUserOnly(input.userId, async (db) => {
    if (!input.favourite) {
      // guardrail-allow: cross-tenant — the person's own heart, by their session id.
      await db.favouriteVenue.deleteMany({
        where: { userId: input.userId, venueId: input.venueId },
      });
      return { favourite: false };
    }
    // guardrail-allow: cross-tenant — the person's own hearts, by their session id.
    const count = await db.favouriteVenue.count({ where: { userId: input.userId } });
    // guardrail-allow: cross-tenant — as above.
    const exists = await db.favouriteVenue.findUnique({
      where: { userId_venueId: { userId: input.userId, venueId: input.venueId } },
      select: { venueId: true },
    });
    if (exists) return { favourite: true };
    if (count >= MAX_FAVOURITE_VENUES) throw new TooManyFavouritesError();
    // guardrail-allow: cross-tenant — as above.
    await db.favouriteVenue.create({ data: { userId: input.userId, venueId: input.venueId } });
    return { favourite: true };
  });
}
