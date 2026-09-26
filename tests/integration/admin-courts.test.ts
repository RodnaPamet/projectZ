import { listCourts, courtsWereTruncated, COURT_LIST_LIMIT } from '@/app-layer/repositories/court';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE COURTS LIST, BOUND THE WAY THE ADMIN PAGE BINDS IT.
 *
 * The page runs `runInTenantContext(tenantId, db => listCourts(db, tenantId))`.
 * Picking the wrong binding does not raise — it returns another club's courts,
 * or none, and the screen renders either without complaint. So the test drives
 * the real binding rather than a raw client.
 */

describe('listCourts', () => {
  const db = prismaTestClient();

  async function court(
    tenantId: string,
    venueId: string,
    over: Partial<{
      name: string;
      status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
      basePriceCents: number;
    }> = {},
  ) {
    return asAppSuperuser(db, (tx) =>
      tx.resource.create({
        data: {
          tenantId,
          venueId,
          name: over.name ?? 'Court 1',
          sport: 'PADEL',
          surface: 'ARTIFICIAL_GRASS',
          basePriceCents: over.basePriceCents ?? 2400,
          status: over.status ?? 'ACTIVE',
        },
        select: { id: true },
      }),
    );
  }

  async function venueFor(tenantId: string) {
    return asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId,
          name: 'Main site',
          slug: `site-${tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `site-${tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
  }

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: returns this club’s courts and not another club’s', async () => {
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const myVenue = await venueFor(mine.tenantId);
    const theirVenue = await venueFor(theirs.tenantId);

    await court(mine.tenantId, myVenue.id, { name: 'Mine A' });
    await court(mine.tenantId, myVenue.id, { name: 'Mine B' });
    await court(theirs.tenantId, theirVenue.id, { name: 'Theirs' });

    const rows = await runInTenantContext(mine.tenantId, (c) => listCourts(c, mine.tenantId));

    expect(rows.map((r) => r.name).sort()).toEqual(['Mine A', 'Mine B']);
  });

  it('hides CLOSED courts by default, and shows them when asked', async () => {
    // CLOSED is the archive: a decommissioned court still has bookings,
    // payments and ledger rows pointing at it, so the row stays and the list
    // stops showing it.
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    await court(t.tenantId, v.id, { name: 'Live' });
    await court(t.tenantId, v.id, { name: 'Retired', status: 'CLOSED' });

    const def = await runInTenantContext(t.tenantId, (c) => listCourts(c, t.tenantId));
    expect(def.map((r) => r.name)).toEqual(['Live']);

    const all = await runInTenantContext(t.tenantId, (c) =>
      listCourts(c, t.tenantId, { includeArchived: true }),
    );
    expect(all.map((r) => r.name).sort()).toEqual(['Live', 'Retired']);
  });

  it('keeps SUSPENDED courts visible — they are paused, not archived', async () => {
    // A court closed for resurfacing must stay on the screen, or staff cannot
    // find it to reopen it.
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    await court(t.tenantId, v.id, { name: 'Resurfacing', status: 'SUSPENDED' });

    const rows = await runInTenantContext(t.tenantId, (c) => listCourts(c, t.tenantId));
    expect(rows.map((r) => r.name)).toEqual(['Resurfacing']);
  });

  it('orders by venue then name, with id breaking ties', async () => {
    // `name` carries no unique constraint, so two courts may share one. An
    // unstable order makes the list reshuffle between renders.
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    await court(t.tenantId, v.id, { name: 'B' });
    await court(t.tenantId, v.id, { name: 'A' });
    await court(t.tenantId, v.id, { name: 'A' });

    const rows = await runInTenantContext(t.tenantId, (c) => listCourts(c, t.tenantId));
    expect(rows.map((r) => r.name)).toEqual(['A', 'A', 'B']);
    // Deterministic across calls.
    const again = await runInTenantContext(t.tenantId, (c) => listCourts(c, t.tenantId));
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('is bounded, and says so rather than quietly truncating', async () => {
    // `take` is required by query-shape's D2 rule. The screen needs to know
    // when the cap bit, or a club reads a partial list as a complete one.
    expect(COURT_LIST_LIMIT).toBeGreaterThan(0);
    expect(courtsWereTruncated(new Array(COURT_LIST_LIMIT).fill(null))).toBe(true);
    expect(courtsWereTruncated(new Array(COURT_LIST_LIMIT - 1).fill(null))).toBe(false);
  });

  it('returns nothing when bound to the WRONG tenant, rather than everything', async () => {
    // The failure mode the explicit tenantId filter exists for: if the binding
    // and the filter ever disagree, the answer must be empty, never another
    // club's rows.
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const v = await venueFor(mine.tenantId);
    await court(mine.tenantId, v.id, { name: 'Mine' });

    const rows = await runInTenantContext(theirs.tenantId, (c) => listCourts(c, theirs.tenantId));
    expect(rows).toEqual([]);
  });
});
