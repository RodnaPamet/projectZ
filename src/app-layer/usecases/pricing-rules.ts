import type { Prisma, PrismaClient } from '@prisma/client';

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
