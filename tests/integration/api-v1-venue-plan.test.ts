import { NextRequest } from 'next/server';

import { GET as planRoute } from '@/app/api/v1/venues/[id]/plan/route';

import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * GET /api/v1/venues/{id}/plan (#623): where a venue's courts lie, public like
 * the venue. Shapes are read through `parseOutline`: a bad one is left off.
 */
const db = prismaTestClient();

interface Plan {
  venueId: string;
  courts: Array<{ resourceId: string; name: string; outline: number[][]; source: string }>;
  features: Array<{ kind: string; outline: number[][]; source: string }>;
  attribution: string | null;
}

async function read(venueId: string) {
  const res = await planRoute(
    new NextRequest(`http://localhost:3000/api/v1/venues/${venueId}/plan`),
    {
      params: Promise.resolve({ id: venueId }),
    },
  );
  return { res, body: (await res.json()) as { data: Plan; error?: { code: string } } };
}

const RECT = [
  [0, 0],
  [10.97, 0],
  [10.97, 23.77],
  [0, 23.77],
];

describe('GET /api/v1/venues/{id}/plan (#623)', () => {
  let club: SeededTenant;
  let venue: { venueId: string; venueSlug: string; resourceId: string };

  beforeEach(async () => {
    club = await seedTenant({});
    venue = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
  });

  const outline = (resourceId: string, data: Record<string, unknown>) =>
    asAppSuperuser(db, (tx) => tx.resource.update({ where: { id: resourceId }, data }));

  it('no outlines: no plan, and a client keeps its list', async () => {
    const { res, body } = await read(venue.venueId);
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      venueId: venue.venueId,
      courts: [],
      features: [],
      attribution: null,
    });
  });

  it('a court imported from OSM, with the grounds, credits OpenStreetMap', async () => {
    await outline(venue.resourceId, {
      planOutline: RECT,
      planSource: 'OSM',
      planOsmWayId: BigInt(123456789),
    });
    await asAppSuperuser(db, (tx) =>
      tx.venuePlanFeature.create({
        data: {
          tenantId: club.tenantId,
          venueId: venue.venueId,
          kind: 'GROUNDS',
          outline: [
            [-5, -5],
            [30, -5],
            [30, 40],
            [-5, 40],
          ],
          source: 'CLUB',
        },
      }),
    );
    const { body } = await read(venue.venueId);
    expect(body.data.courts).toEqual([
      expect.objectContaining({ resourceId: venue.resourceId, outline: RECT, source: 'OSM' }),
    ]);
    expect(body.data.features).toEqual([
      expect.objectContaining({ kind: 'GROUNDS', source: 'CLUB' }),
    ]);
    expect(body.data.attribution).toBe('OpenStreetMap');
    // The OSM way id stays on the server: a client has no use for it.
    expect(JSON.stringify(body.data)).not.toContain('123456789');
  });

  it('a club’s own drawing credits nobody', async () => {
    await outline(venue.resourceId, { planOutline: RECT, planSource: 'CLUB' });
    const { body } = await read(venue.venueId);
    expect(body.data.courts).toHaveLength(1);
    expect(body.data.attribution).toBeNull();
  });

  it('a shape that is not a sane polygon, or a court out of use, is not on the plan', async () => {
    await outline(venue.resourceId, {
      planOutline: [
        [0, 0],
        [1, 1],
      ],
      planSource: 'CLUB',
    });
    const second = await asAppSuperuser(db, (tx) =>
      tx.resource.findFirstOrThrow({ where: { id: venue.resourceId } }),
    );
    const retired = await asAppSuperuser(db, (tx) =>
      tx.resource.create({
        data: {
          tenantId: club.tenantId,
          venueId: venue.venueId,
          name: 'Стар корт',
          sport: second.sport,
          surface: second.surface,
          basePriceCents: 1000,
          status: 'SUSPENDED',
          planOutline: RECT,
          planSource: 'CLUB',
        },
      }),
    );
    const { body } = await read(venue.venueId);
    expect(body.data.courts.map((c) => c.resourceId)).not.toContain(retired.id);
    expect(body.data.courts).toEqual([]);
  });

  it('the database keeps a shape whole: an outline needs its source', async () => {
    await expect(outline(venue.resourceId, { planOutline: RECT })).rejects.toThrow();
    await expect(
      outline(venue.resourceId, { planOutline: RECT, planSource: 'CLUB', planOsmWayId: BigInt(1) }),
    ).rejects.toThrow();
  });

  it('a suspended club’s plan is a 404, as its venue', async () => {
    await outline(venue.resourceId, { planOutline: RECT, planSource: 'CLUB' });
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenantId }, data: { status: 'SUSPENDED' } }),
    );
    const { res, body } = await read(venue.venueId);
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});
