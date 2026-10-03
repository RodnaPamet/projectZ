import type { Prisma } from '@prisma/client';

import type { PricingConditions, PricingRuleRow } from '@/app-layer/usecases/pricing';

/**
 * A pricing rule as the pricing screen holds it, and the way back to the engine.
 *
 * ═══ WHY THERE IS A WAY BACK (#350) ═══
 *
 * The screen renames `conditionsJson` to `conditions` and narrows the Decimal
 * multiplier to a number. The preview handed these views to `computeSpanPrice`
 * through `as unknown as PricingRuleRow[]`; the engine reads
 * `rule.conditionsJson ?? {}`, found nothing under that name, and so
 * evaluated every rule with NO conditions. Every rule matched every day and
 * time: a Saturday-only peak priced Thursday 19:00 at the weekend rate. The
 * double cast is what kept the type checker from saying so.
 *
 * So both directions live here, typed, with no cast, and the preview goes
 * through `toEngineRules`.
 */
export interface PricingRuleView {
  id: string;
  name: string;
  priority: number;
  /** Already narrowed from Prisma.Decimal at the server boundary. */
  multiplier: number | null;
  fixedPriceCents: number | null;
  conditions: PricingConditions;
}

/** What the page reads from the database for one rule. */
export interface PricingRuleSource {
  id: string;
  name: string;
  priority: number;
  multiplier: Prisma.Decimal | number | null;
  fixedPriceCents: number | null;
  conditionsJson: Prisma.JsonValue;
}

/** Database row → the screen's view. Decimal → number, at the boundary, once. */
export function toPricingRuleView(r: PricingRuleSource): PricingRuleView {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    multiplier: r.multiplier === null ? null : Number(r.multiplier),
    fixedPriceCents: r.fixedPriceCents,
    conditions: (r.conditionsJson ?? {}) as PricingConditions,
  };
}

/** The screen's views → what `computePrice` reads. */
export function toEngineRules(views: readonly PricingRuleView[]): PricingRuleRow[] {
  return views.map((v) => ({
    id: v.id,
    name: v.name,
    priority: v.priority,
    multiplier: v.multiplier,
    fixedPriceCents: v.fixedPriceCents,
    conditionsJson: v.conditions,
  }));
}
