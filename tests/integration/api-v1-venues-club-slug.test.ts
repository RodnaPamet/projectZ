import { NextRequest } from 'next/server';

import { GET as getVenue } from '@/app/api/v1/venues/[id]/route';
import { GET as listVenuesRoute } from '@/app/api/v1/venues/route';

import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * `clubSlug` on the public venue DTOs (T16).
 *
 * The iOS client booked with the VENUE's slug, because no public DTO carried
 * the club's — and `POST /t/{slug}/bookings` takes the club's. Those coincide
 * only when a club names its venue after itself, which `seedVenue` makes sure
 * these venues do not.
 */
const db = prismaTestClient();

interface Summary {
  id: string;
  slug: string;
  clubSlug: string;
}

const list = async (q: string) => {
  const res = await listVenuesRoute(
    new NextRequest(`http://localhost:3000/api/v1/venues?q=${encodeURIComponent(q)}`),
    undefined,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { items: Summary[]; nextCursor: string | null } }).data;
};

const detail = (id: string) =>
  getVenue(new NextRequest(`http://localhost:3000/api/v1/venues/${id}`), {
    params: Promise.resolve({ id }),
  });

describe('clubSlug on the v1 venue routes', () => {
  let clubA: SeededTenant;
  let clubB: SeededTenant;
  let tag: string;

  beforeEach(async () => {
    clubA = await seedTenant({});
    clubB = await seedTenant({});
    // A name no other test's venue carries, so the public list can be read as
    // "exactly these" without a reset.
    tag = `ClubSlug ${Math.random().toString(36).slice(2, 10)}`;
  });

  it("GET /venues gives every venue ITS club's slug, not the venue's own", async () => {
    const a = await seedVenue(clubA.tenantId, { name: `${tag} A` });
    const b1 = await seedVenue(clubB.tenantId, { name: `${tag} B1` });
    const b2 = await seedVenue(clubB.tenantId, { name: `${tag} B2` });

    const { items } = await list(tag);
    const byId = new Map(items.map((v) => [v.id, v]));

    expect(items).toHaveLength(3);
    expect(byId.get(a.venueId)).toMatchObject({ slug: a.venueSlug, clubSlug: clubA.tenantSlug });
    expect(byId.get(b1.venueId)).toMatchObject({ clubSlug: clubB.tenantSlug });
    expect(byId.get(b2.venueId)).toMatchObject({ clubSlug: clubB.tenantSlug });
    for (const v of items) expect(v.clubSlug).not.toBe(v.slug);
  });

  it('GET /venues/{id} carries the same clubSlug', async () => {
    const a = await seedVenue(clubA.tenantId, { name: `${tag} A` });

    const res = await detail(a.venueId);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Summary & { timezone: string } };
    expect(data).toMatchObject({ id: a.venueId, slug: a.venueSlug, clubSlug: clubA.tenantSlug });
  });

  it('a venue whose club row is gone is left out of the list and is a 404 — never an empty slug', async () => {
    // `venue.tenantId` is not a foreign key, so this row can exist. Such a
    // venue cannot be booked, and `clubSlug: ""` would send a client to
    // `/t//bookings`.
    const kept = await seedVenue(clubA.tenantId, { name: `${tag} kept` });
    const orphan = await seedVenue(clubB.tenantId, { name: `${tag} orphan` });
    await asAppSuperuser(db, async (tx) => {
      // The club goes with its memberships; the venue stays behind.
      await tx.tenantMembership.deleteMany({ where: { tenantId: clubB.tenantId } });
      await tx.venueOrg.delete({ where: { id: clubB.tenantId } });
    });

    const { items } = await list(tag);
    expect(items.map((v) => v.id)).toEqual([kept.venueId]);
    expect((await detail(orphan.venueId)).status).toBe(404);
  });
});
