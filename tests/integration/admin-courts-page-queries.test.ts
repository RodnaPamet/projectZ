import { loadCourtsScreen } from '@/app-layer/usecases/courts';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { countQueries, disconnectQueryCountingClient } from '../helpers/query-count';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE COURTS PAGE COSTS THE SAME FOR ONE COURT AS FOR EIGHT (T23).
 *
 * The page used to await one `booking.count` per court, inside its
 * transaction — an N+1 that the perf seed's 8 courts hide in milliseconds, so
 * the proof is a query count, not a timing. `loadCourtsScreen` is exactly what
 * the page runs, bound the way the page binds it, through a client that logs
 * every statement Postgres receives.
 *
 * Measured: 7 statements for 1 court and 7 for 8 (the RLS binding, courts,
 * their venues, the club's venues, one grouped booking count, COMMIT). The
 * per-court loop it replaced made 7 and 14.
 */

describe('courts page data load', () => {
  const db = prismaTestClient();

  afterAll(async () => {
    await disconnectQueryCountingClient();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function clubWithCourts(n: number) {
    const t = await seedTenant({}, db);
    const courtIds = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          name: 'Main site',
          slug: `site-${t.tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `site-${t.tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      });
      const ids: string[] = [];
      for (let i = 1; i <= n; i++) {
        const court = await tx.resource.create({
          data: {
            tenantId: t.tenantId,
            venueId: venue.id,
            name: `Court ${i}`,
            sport: 'PADEL',
            surface: 'ARTIFICIAL_GRASS',
            basePriceCents: 2400,
          },
          select: { id: true },
        });
        // One upcoming booking on every court, so each one has a count to load.
        const start = Date.now() + 172_800_000;
        await tx.booking.create({
          data: {
            tenantId: t.tenantId,
            resourceId: court.id,
            bookedByUserId: t.userId,
            startTs: new Date(start),
            endTs: new Date(start + 3_600_000),
            status: 'CONFIRMED',
            totalCents: 2400,
            idempotencyKey: `page-queries-${court.id}`,
          },
        });
        ids.push(court.id);
      }
      return ids;
    });
    return { tenantId: t.tenantId, courtIds };
  }

  const load = (tenantId: string) =>
    countQueries((client) =>
      runInTenantContext(tenantId, (tx) => loadCourtsScreen(tx, tenantId, new Date()), client),
    );

  it('THE POINT: issues the same number of queries for 1 court and for 8', async () => {
    const one = await clubWithCourts(1);
    const eight = await clubWithCourts(8);

    const a = await load(one.tenantId);
    const b = await load(eight.tenantId);

    // The loads are real: every court and its booking came back.
    expect(a.result.courts).toHaveLength(1);
    expect(b.result.courts).toHaveLength(8);
    for (const id of eight.courtIds) expect(b.result.upcoming.get(id)).toBe(1);

    expect(a.queries.length).toBeGreaterThan(0);
    expect(b.queries).toHaveLength(a.queries.length);
  });

  it('counts the bookings with one grouped statement, not one per court', async () => {
    const club = await clubWithCourts(8);
    const { queries } = await load(club.tenantId);

    const bookingReads = queries.filter((q) => /FROM\s+"public"\."booking"/i.test(q));
    expect(bookingReads).toHaveLength(1);
    expect(bookingReads[0]).toMatch(/GROUP BY/i);
  });
});
