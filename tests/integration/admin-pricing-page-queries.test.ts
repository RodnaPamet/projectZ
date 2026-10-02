import { loadPricingScreen } from '@/app-layer/usecases/pricing-rules';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { countQueries, disconnectQueryCountingClient } from '../helpers/query-count';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE PRICING PAGE COSTS THE SAME FOR ONE COURT AS FOR EIGHT (T24).
 *
 * The page used to await one `listPricingRules` per court, inside its
 * transaction — an N+1 that the perf seed's 8 courts hide in milliseconds, so
 * the proof is a query count, not a timing. `loadPricingScreen` is exactly
 * what the page runs, bound the way the page binds it, through a client that
 * logs every statement Postgres receives.
 *
 * Measured: 6 statements for 1 court and 6 for 8 (the two RLS binding
 * statements, courts, their venues, one rules read, COMMIT). The per-court
 * loop it replaced made 6 and 13.
 */

describe('pricing page data load', () => {
  const db = prismaTestClient();

  afterAll(async () => {
    await disconnectQueryCountingClient();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  /** `n` courts with three rules each, at mixed priorities. */
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
        await tx.pricingRule.createMany({
          data: [100, 300, 200].map((priority) => ({
            tenantId: t.tenantId,
            resourceId: court.id,
            name: `Court ${i} at ${priority}`,
            priority,
            conditionsJson: { dayOfWeek: [6, 0] },
            multiplier: 1.2,
          })),
        });
        ids.push(court.id);
      }
      return ids;
    });
    return { tenantId: t.tenantId, courtIds };
  }

  const load = (tenantId: string) =>
    countQueries((client) =>
      runInTenantContext(tenantId, (tx) => loadPricingScreen(tx, tenantId), client),
    );

  it('THE POINT: issues the same number of queries for 1 court and for 8', async () => {
    const one = await clubWithCourts(1);
    const eight = await clubWithCourts(8);

    const a = await load(one.tenantId);
    const b = await load(eight.tenantId);

    // The loads are real: every court and every one of its rules came back.
    expect(a.result.courts).toHaveLength(1);
    expect(b.result.courts).toHaveLength(8);
    for (const id of eight.courtIds) expect(b.result.rulesByCourt.get(id)).toHaveLength(3);

    expect(a.queries.length).toBeGreaterThan(0);
    expect(b.queries).toHaveLength(a.queries.length);
  });

  it('reads the rules with one statement, not one per court', async () => {
    const club = await clubWithCourts(8);
    const { queries } = await load(club.tenantId);

    const ruleReads = queries.filter((q) => /FROM\s+"public"\."pricing_rule"/i.test(q));
    expect(ruleReads).toHaveLength(1);
  });

  it('groups each court its own rules, in the order computePrice considers them', async () => {
    const club = await clubWithCourts(3);
    const { result } = await load(club.tenantId);

    club.courtIds.forEach((id, i) => {
      const rules = result.rulesByCourt.get(id)!;
      expect(rules.map((r) => r.priority)).toEqual([300, 200, 100]);
      expect(rules.every((r) => r.resourceId === id)).toBe(true);
      expect(rules[0]!.name).toBe(`Court ${i + 1} at 300`);
    });
  });

  it('gives a court with no rules an empty list, and another club none of ours', async () => {
    const ours = await clubWithCourts(2);
    const theirs = await clubWithCourts(1);
    // Strip the second court's rules.
    await asAppSuperuser(db, (tx) =>
      tx.pricingRule.deleteMany({ where: { resourceId: ours.courtIds[1] } }),
    );

    const { result } = await load(ours.tenantId);
    expect(result.rulesByCourt.get(ours.courtIds[0]!)).toHaveLength(3);
    expect(result.rulesByCourt.get(ours.courtIds[1]!)).toEqual([]);
    expect(result.rulesByCourt.has(theirs.courtIds[0]!)).toBe(false);
  });
});
