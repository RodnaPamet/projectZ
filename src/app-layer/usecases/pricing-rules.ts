import type { Prisma, PrismaClient } from '@prisma/client';

import { listCourts } from '@/app-layer/repositories/court';
import type { PricingRuleWrite } from '@/app-layer/schemas/pricing';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * Managing the rules that `computePrice` evaluates.
 *
 * ═══ WHY DELETE IS ALLOWED HERE AND NOT FOR COURTS ═══
 *
 * A court cannot be deleted: every booking made on it references it, and
 * through those, payments and the ledger. A pricing rule references nothing and
 * nothing references it — a booking stores `totalCents`, the price it was
 * actually charged, not the rule that produced it. Removing a rule changes what
 * FUTURE bookings cost and rewrites no history.
 *
 * The audit row still records what was removed, because "why did Saturday get
 * cheaper?" is otherwise unanswerable.
 *
 * ═══ THE CALLER BINDS, AND PASSES tenantId ═══
 *
 * As everywhere in this layer: `runInTenantContext` for the binding, plus an
 * explicit `tenantId` in the where clause, because RLS alone yields a silent
 * empty list and a future caller under `app_superuser` would leak.
 */

export class PricingRuleNotFoundError extends Error {
  constructor() {
    super('No pricing rule with that id at this club.');
    this.name = 'PricingRuleNotFoundError';
  }
}

export class CourtNotAtThisClubError extends Error {
  constructor() {
    super(
      'That court does not belong to this club. PricingRule.resourceId has no composite ' +
        'foreign key to (tenantId, resourceId), so the database would accept the row.',
    );
    this.name = 'CourtNotAtThisClubError';
  }
}

const AUDITED = {
  id: true,
  name: true,
  priority: true,
  conditionsJson: true,
  multiplier: true,
  fixedPriceCents: true,
  resourceId: true,
} as const;

/** The rules for one court, in the order `computePrice` will consider them. */
export async function listPricingRules(db: PrismaClient, tenantId: string, resourceId: string) {
  return db.pricingRule.findMany({
    where: { tenantId, resourceId },
    select: AUDITED,
    // Descending, matching computePrice's own sort. The engine re-sorts rather
    // than trusting this — a repository that dropped the clause would silently
    // apply the wrong price — but the screen must show the order that decides.
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
    take: 200,
  });
}

/** The most rules one court's list reads — the cap `listPricingRules` always had. */
export const PRICING_RULES_PER_COURT = 200;

export type PricingRuleListItem = Awaited<ReturnType<typeof listPricingRules>>[number];

/**
 * The rules for SEVERAL courts, in ONE query, grouped by court in memory.
 *
 * ═══ WHY ONE QUERY, NOT `listPricingRules` PER COURT ═══
 *
 * The pricing page awaited `listPricingRules` once per court inside its
 * transaction — an N+1 that the perf seed's 8 courts hide in milliseconds and a
 * 40-court club pays 40 round trips for. Measured with
 * tests/helpers/query-count.ts, the screen's load was 6 statements for 1 court
 * and 13 for 8; it is now 6 for both
 * (tests/integration/admin-pricing-page-queries.test.ts).
 *
 * ═══ ORDER AND BOUND ═══
 *
 * Sorted by court, then exactly as `listPricingRules` sorts (priority desc, id
 * asc), so each court's slice keeps the order `computePrice` will consider the
 * rules in — the grouping below only appends, it never re-sorts. The bound is
 * the old per-court cap times the number of courts, so a club whose every court
 * is at the cap still reads every rule. A court over the cap could crowd a
 * later court out; nothing a club does reaches 200 rules on one court, and the
 * per-court query it replaces truncated silently at the same 200.
 *
 * Every requested court is in the map, an empty list when it has none, so a
 * caller never has to tell "no rules" from "not asked". No ids, no query.
 */
export async function listPricingRulesForCourts(
  db: PrismaClient,
  tenantId: string,
  courtIds: readonly string[],
): Promise<Map<string, PricingRuleListItem[]>> {
  const byCourt = new Map<string, PricingRuleListItem[]>(courtIds.map((id) => [id, []]));
  if (courtIds.length === 0) return byCourt;

  const rows = await db.pricingRule.findMany({
    where: { tenantId, resourceId: { in: [...courtIds] } },
    select: AUDITED,
    orderBy: [{ resourceId: 'asc' }, { priority: 'desc' }, { id: 'asc' }],
    take: PRICING_RULES_PER_COURT * courtIds.length,
  });

  for (const row of rows) {
    const list = byCourt.get(row.resourceId);
    if (list && list.length < PRICING_RULES_PER_COURT) list.push(row);
  }
  return byCourt;
}

/**
 * Everything the pricing screen reads, inside the one transaction the caller
 * binds (`runInTenantContext`): the courts, then all their rules in one query.
 *
 * Archived courts are excluded: a closed court takes no bookings, so its prices
 * decide nothing. Sequential, not `Promise.all` — the reads share the
 * transaction's single connection, on which concurrent statements interleave.
 */
export async function loadPricingScreen(db: PrismaClient, tenantId: string) {
  const courts = await listCourts(db, tenantId);
  const rulesByCourt = await listPricingRulesForCourts(
    db,
    tenantId,
    courts.map((c) => c.id),
  );
  return { courts, rulesByCourt };
}

/** The court must be one of ours before a rule can point at it. */
async function assertOwnCourt(db: PrismaClient, tenantId: string, resourceId: string) {
  const court = await db.resource.findFirst({
    where: { id: resourceId, tenantId },
    select: { id: true },
  });
  if (!court) throw new CourtNotAtThisClubError();
}

export async function createPricingRule(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  input: PricingRuleWrite,
) {
  await assertOwnCourt(db, tenantId, input.resourceId);

  const rule = await db.pricingRule.create({
    data: {
      tenantId,
      resourceId: input.resourceId,
      name: input.name,
      priority: input.priority,
      conditionsJson: input.conditions as Prisma.InputJsonValue,
      multiplier: input.multiplier,
      fixedPriceCents: input.fixedPriceCents,
    },
    select: AUDITED,
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'PricingRule',
    entityId: rule.id,
    action: AUDIT_ACTIONS.PRICING_RULE_CREATED,
    details: `Pricing rule "${rule.name}" added`,
    detailsJson: { category: 'config', summary: 'Pricing rule created', after: rule },
  });

  return rule;
}

export async function updatePricingRule(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  ruleId: string,
  input: PricingRuleWrite,
) {
  const before = await db.pricingRule.findFirst({
    where: { id: ruleId, tenantId },
    select: AUDITED,
  });
  if (!before) throw new PricingRuleNotFoundError();
  await assertOwnCourt(db, tenantId, input.resourceId);

  const after = await db.pricingRule.update({
    where: { id: ruleId },
    data: {
      resourceId: input.resourceId,
      name: input.name,
      priority: input.priority,
      conditionsJson: input.conditions as Prisma.InputJsonValue,
      multiplier: input.multiplier,
      fixedPriceCents: input.fixedPriceCents,
    },
    select: AUDITED,
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'PricingRule',
    entityId: ruleId,
    action: AUDIT_ACTIONS.PRICING_RULE_UPDATED,
    details: `Pricing rule "${after.name}" updated`,
    detailsJson: { category: 'config', summary: 'Pricing rule updated', before, after },
  });

  return after;
}

export async function deletePricingRule(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  ruleId: string,
) {
  const before = await db.pricingRule.findFirst({
    where: { id: ruleId, tenantId },
    select: AUDITED,
  });
  if (!before) throw new PricingRuleNotFoundError();

  // deleteMany, not delete: `where` on a unique delete cannot carry tenantId,
  // so a bare delete-by-id would reach another club's row if the read above
  // ever stopped scoping. Belt and braces, same as everywhere else here.
  await db.pricingRule.deleteMany({ where: { id: ruleId, tenantId } });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'PricingRule',
    entityId: ruleId,
    action: AUDIT_ACTIONS.PRICING_RULE_DELETED,
    details: `Pricing rule "${before.name}" removed`,
    detailsJson: { category: 'config', summary: 'Pricing rule deleted', before },
  });

  return before;
}
