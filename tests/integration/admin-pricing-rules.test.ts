import {
  CourtNotAtThisClubError,
  createPricingRule,
  deletePricingRule,
  listPricingRules,
  PricingRuleNotFoundError,
  updatePricingRule,
} from '@/app-layer/usecases/pricing-rules';
import { computePrice } from '@/app-layer/usecases/pricing';
import { createCourt } from '@/app-layer/usecases/courts';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * PRICING RULES, AND THE ENGINE THAT READS THEM.
 *
 * The screen's value is the preview: it shows what a booking would cost and
 * WHICH rule decided. That is only worth showing if the rules the screen writes
 * are the rules `computePrice` understands — `conditionsJson` is a `Json`
 * column, so a misspelled key stores fine, evaluates to nothing, and looks
 * correct in the list.
 *
 * So these tests write through the use case and price through the engine.
 */

const COURT = {
  name: 'Court 1',
  sport: 'PADEL',
  resourceType: 'COURT',
  surface: 'ARTIFICIAL_GRASS',
  isIndoor: false,
  capacity: 4,
  basePriceCents: 2400,
  minBookingMinutes: 60,
  maxBookingMinutes: 180,
  slotStepMinutes: 30,
} as const;

describe('pricing rules', () => {
  const db = prismaTestClient();

  async function club(tag = 'a') {
    const t = await seedTenant({}, db);
    const venue = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: t.tenantId,
          name: `Site ${tag}`,
          slug: `site-${tag}-${t.tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `s-${tag}-${t.tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...COURT, venueId: venue.id }),
    );
    return { ...t, courtId: court.id };
  }

  const rule = (resourceId: string, over: Record<string, unknown> = {}) => ({
    resourceId,
    name: 'Peak evenings',
    priority: 200,
    conditions: { dayOfWeek: [1, 2, 3, 4, 5], timeRange: { from: '18:00', to: '22:00' } },
    multiplier: 1.4,
    fixedPriceCents: null,
    ...over,
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: a rule written here is a rule the engine applies', async () => {
    // `conditionsJson` is a Json column. A key the schema does not recognise
    // stores fine and evaluates to nothing, so the only proof that the writer
    // and the reader agree is to write one and price against it.
    const c = await club();
    await runInTenantContext(c.tenantId, (db2) =>
      createPricingRule(db2, c.tenantId, c.userId, rule(c.courtId)),
    );

    const rules = await runInTenantContext(c.tenantId, (db2) =>
      listPricingRules(db2, c.tenantId, c.courtId),
    );

    // Thursday (4) at 19:00–20:00 — inside the window.
    const priced = computePrice(rules, {
      basePriceCents: 2400,
      localDayOfWeek: 4,
      localStartMinutes: 19 * 60,
      localEndMinutes: 20 * 60,
    });

    expect(priced.finalPriceCents).toBe(3360);
    expect(priced.appliedRuleId).toBe(rules[0]!.id);
    expect(priced.ruleTrace).toHaveLength(1);
    expect(priced.ruleTrace[0]!.matched).toBe(true);
  });

  it('honours priority: the higher rule wins and the lower is traced as skipped', async () => {
    // The trace is what the preview renders. A rule that lost must be
    // distinguishable from a rule that did not match.
    const c = await club();
    await runInTenantContext(c.tenantId, async (db2) => {
      await createPricingRule(db2, c.tenantId, c.userId, rule(c.courtId));
      await createPricingRule(
        db2,
        c.tenantId,
        c.userId,
        rule(c.courtId, {
          name: 'Weekday flat',
          priority: 100,
          conditions: { dayOfWeek: [1, 2, 3, 4, 5] },
          multiplier: null,
          fixedPriceCents: 1800,
        }),
      );
    });

    const rules = await runInTenantContext(c.tenantId, (db2) =>
      listPricingRules(db2, c.tenantId, c.courtId),
    );
    expect(rules.map((r) => r.priority)).toEqual([200, 100]);

    const priced = computePrice(rules, {
      basePriceCents: 2400,
      localDayOfWeek: 4,
      localStartMinutes: 19 * 60,
      localEndMinutes: 20 * 60,
    });

    expect(priced.finalPriceCents).toBe(3360);
    const loser = priced.ruleTrace.find((t) => t.ruleName === 'Weekday flat')!;
    expect(loser.matched).toBe(false);
    expect(loser.reason).toMatch(/higher-priority/);
  });

  it('REFUSES a court belonging to another club', async () => {
    // Same hole as Resource.venueId: PricingRule.resourceId has no composite
    // FK to (tenantId, resourceId), so the database accepts the row.
    const mine = await club('mine');
    const theirs = await club('theirs');

    await expect(
      runInTenantContext(mine.tenantId, (db2) =>
        createPricingRule(db2, mine.tenantId, mine.userId, rule(theirs.courtId)),
      ),
    ).rejects.toThrow(CourtNotAtThisClubError);

    const theirRules = await runInTenantContext(theirs.tenantId, (db2) =>
      listPricingRules(db2, theirs.tenantId, theirs.courtId),
    );
    expect(theirRules).toHaveLength(0);
  });

  it('cannot update or delete another club’s rule', async () => {
    const mine = await club('m');
    const theirs = await club('t');
    const theirRule = await runInTenantContext(theirs.tenantId, (db2) =>
      createPricingRule(db2, theirs.tenantId, theirs.userId, rule(theirs.courtId)),
    );

    await expect(
      runInTenantContext(mine.tenantId, (db2) =>
        updatePricingRule(db2, mine.tenantId, mine.userId, theirRule.id, rule(mine.courtId)),
      ),
    ).rejects.toThrow(PricingRuleNotFoundError);

    await expect(
      runInTenantContext(mine.tenantId, (db2) =>
        deletePricingRule(db2, mine.tenantId, mine.userId, theirRule.id),
      ),
    ).rejects.toThrow(PricingRuleNotFoundError);

    const still = await runInTenantContext(theirs.tenantId, (db2) =>
      listPricingRules(db2, theirs.tenantId, theirs.courtId),
    );
    expect(still).toHaveLength(1);
  });

  it('deleting a rule is allowed, and audited', async () => {
    // Unlike a court: nothing references a pricing rule. A booking stores the
    // price it was charged, not the rule that produced it, so removing one
    // changes future bookings and rewrites no history.
    const c = await club();
    const created = await runInTenantContext(c.tenantId, (db2) =>
      createPricingRule(db2, c.tenantId, c.userId, rule(c.courtId)),
    );

    await runInTenantContext(c.tenantId, (db2) =>
      deletePricingRule(db2, c.tenantId, c.userId, created.id),
    );

    const rules = await runInTenantContext(c.tenantId, (db2) =>
      listPricingRules(db2, c.tenantId, c.courtId),
    );
    expect(rules).toHaveLength(0);

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: c.tenantId, entity: 'PricingRule' },
        select: { action: true, detailsJson: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual(['PRICING_RULE_CREATED', 'PRICING_RULE_DELETED']);
    const d = audit[1]!.detailsJson as { before?: { name?: string } };
    expect(d.before?.name).toBe('Peak evenings');
  });

  it('records the BEFORE conditions on an update', async () => {
    const c = await club();
    const created = await runInTenantContext(c.tenantId, (db2) =>
      createPricingRule(db2, c.tenantId, c.userId, rule(c.courtId)),
    );

    await runInTenantContext(c.tenantId, (db2) =>
      updatePricingRule(
        db2,
        c.tenantId,
        c.userId,
        created.id,
        rule(c.courtId, { multiplier: 1.6 }),
      ),
    );

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirst({
        where: { tenantId: c.tenantId, action: 'PRICING_RULE_UPDATED' },
        select: { detailsJson: true },
      }),
    );
    const d = audit!.detailsJson as {
      before?: { multiplier?: string | number };
      after?: { multiplier?: string | number };
    };
    expect(Number(d.before?.multiplier)).toBeCloseTo(1.4);
    expect(Number(d.after?.multiplier)).toBeCloseTo(1.6);
  });
});
