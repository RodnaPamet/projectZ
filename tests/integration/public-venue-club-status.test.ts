import type { TenantStatus } from '@prisma/client';
import { NextRequest } from 'next/server';

import { GET as legacyList } from '@/app/api/venues/route';
import { GET as availabilityRoute } from '@/app/api/v1/venues/[id]/availability/route';
import { GET as detailRoute } from '@/app/api/v1/venues/[id]/route';
import { GET as nearRoute } from '@/app/api/v1/venues/near/route';
import { GET as listRoute } from '@/app/api/v1/venues/route';
import {
  getVenueByPublicSlug,
  listSitemapVenues,
  listVenueFacets,
} from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * #298: a SUSPENDED or CLOSED club's venues are not public, anywhere.
 *
 * The venue row stays `status: ACTIVE` when its club is suspended, and the
 * index, the filters, `near` and the v1 detail used to check only that, so the
 * cards led to a venue page that 404s. Every public read now goes through
 * `publicVenueFilter`. Each read is asserted both ways: gone while the club is
 * not ACTIVE, back when it is, so a filter that hides everything fails too.
 */
const db = prismaTestClient();
const BASE = 'http://localhost:3000';
// Within 50 km of every seeded venue (seedVenue puts them in central Sofia).
const NEAR = 'lat=42.6977&lng=23.3219&radiusKm=50';

type Item = { id: string };

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

const v1List = async (q: string) =>
  (
    await json<{ data: { items: Item[] } }>(
      await listRoute(
        new NextRequest(`${BASE}/api/v1/venues?q=${encodeURIComponent(q)}`),
        undefined,
      ),
    )
  ).data.items.map((v) => v.id);

const v1Near = async () =>
  (
    await json<{ data: { venues: Item[] } }>(
      await nearRoute(new NextRequest(`${BASE}/api/v1/venues/near?${NEAR}`), undefined),
    )
  ).data.venues.map((v) => v.id);

const v1Detail = (id: string) =>
  detailRoute(new NextRequest(`${BASE}/api/v1/venues/${id}`), {
    params: Promise.resolve({ id }),
  });

const v1Availability = (id: string) =>
  availabilityRoute(new NextRequest(`${BASE}/api/v1/venues/${id}/availability`), {
    params: Promise.resolve({ id }),
  });

const legacy = async (q: string) =>
  (
    await json<{ venues: Item[] }>(
      await legacyList(new NextRequest(`${BASE}/api/venues?q=${encodeURIComponent(q)}`)),
    )
  ).venues.map((v) => v.id);

async function setClubStatus(tenantId: string, status: TenantStatus) {
  await asAppSuperuser(db, (tx) =>
    tx.venueOrg.update({ where: { id: tenantId }, data: { status } }),
  );
}

describe.each(['SUSPENDED', 'CLOSED'] as const)('a %s club’s venues (#298)', (status) => {
  let live: SeededTenant;
  let hidden: SeededTenant;
  let tag: string;
  let liveVenue: { venueId: string };
  let hiddenVenue: { venueId: string };
  let hiddenCity: string;

  beforeEach(async () => {
    live = await seedTenant({});
    hidden = await seedTenant({});
    // A name no other venue carries, so a list can be read as "exactly these".
    tag = `Status ${Math.random().toString(36).slice(2, 10)}`;
    liveVenue = await seedVenue(live.tenantId, { name: `${tag} live` });
    hiddenVenue = await seedVenue(hidden.tenantId, { name: `${tag} hidden` });
    // A city only the hidden club's venue is in, for the facets.
    hiddenCity = `Град ${tag}`;
    await asAppSuperuser(db, (tx) =>
      tx.venue.update({ where: { id: hiddenVenue.venueId }, data: { city: hiddenCity } }),
    );
    await setClubStatus(hidden.tenantId, status);
  });

  it('GET /api/v1/venues leaves it out, and lists it again once the club is ACTIVE', async () => {
    expect(await v1List(tag)).toEqual([liveVenue.venueId]);
    await setClubStatus(hidden.tenantId, 'ACTIVE');
    expect((await v1List(tag)).sort()).toEqual([liveVenue.venueId, hiddenVenue.venueId].sort());
  });

  it('GET /api/v1/venues/near leaves it out, and finds it again once ACTIVE', async () => {
    expect(await v1Near()).toEqual([liveVenue.venueId]);
    await setClubStatus(hidden.tenantId, 'ACTIVE');
    expect((await v1Near()).sort()).toEqual([liveVenue.venueId, hiddenVenue.venueId].sort());
  });

  it('GET /api/v1/venues/{id} is a 404, and a 200 again once ACTIVE', async () => {
    await json(await v1Detail(hiddenVenue.venueId), 404);
    await json(await v1Detail(liveVenue.venueId), 200);
    await setClubStatus(hidden.tenantId, 'ACTIVE');
    const { data } = await json<{ data: Item }>(await v1Detail(hiddenVenue.venueId), 200);
    expect(data.id).toBe(hiddenVenue.venueId);
  });

  it('GET /api/v1/venues/{id}/availability is a 404, and a 200 again once ACTIVE', async () => {
    await json(await v1Availability(hiddenVenue.venueId), 404);
    await setClubStatus(hidden.tenantId, 'ACTIVE');
    await json(await v1Availability(hiddenVenue.venueId), 200);
  });

  it('GET /api/venues (unversioned) leaves it out too', async () => {
    expect(await legacy(tag)).toEqual([liveVenue.venueId]);
    await setClubStatus(hidden.tenantId, 'ACTIVE');
    expect((await legacy(tag)).sort()).toEqual([liveVenue.venueId, hiddenVenue.venueId].sort());
  });

  it('the /venues filters do not offer a city only it is in', async () => {
    const cities = async () => (await runAsSuperuser((tx) => listVenueFacets(tx))).cities;
    expect(await cities()).not.toContain(hiddenCity);
    await setClubStatus(hidden.tenantId, 'ACTIVE');
    expect(await cities()).toContain(hiddenCity);
  });

  it('the venue page and the sitemap use the same predicate', async () => {
    const slugOf = async (id: string) =>
      (
        await asAppSuperuser(db, (tx) =>
          tx.venue.findUniqueOrThrow({ where: { id }, select: { publicSlug: true } }),
        )
      ).publicSlug!;
    const hiddenSlug = await slugOf(hiddenVenue.venueId);
    const page = () => runAsSuperuser((tx) => getVenueByPublicSlug(tx, hiddenSlug));
    const sitemap = async () =>
      (await runAsSuperuser((tx) => listSitemapVenues(tx, 1000))).map((v) => v.publicSlug);

    expect(await page()).toBeNull();
    expect(await sitemap()).not.toContain(hiddenSlug);
    expect(await sitemap()).toContain(await slugOf(liveVenue.venueId));

    await setClubStatus(hidden.tenantId, 'ACTIVE');
    expect((await page())?.id).toBe(hiddenVenue.venueId);
    expect(await sitemap()).toContain(hiddenSlug);
  });
});
