import type { Prisma } from '@prisma/client';

/**
 * The pricing rule engine.
 *
 * A club's pricing is genuinely fiddly — "weekends after 6pm cost 50% more,
 * unless you're a member, and Court 1 is a flat €40 on holidays". Encoding
 * that as `if` statements means a code deploy every time a club changes its
 * prices, so rules are data.
 *
 * `ruleTrace` is not a debugging luxury. When a player asks "why did this
 * cost €36?", support needs an answer, and "the engine decided" is not one.
 * Every rule considered is returned, matched or not, with the reason.
 */

export interface PricingRuleRow {
  id: string;
  name: string;
  priority: number;
  conditionsJson: Prisma.JsonValue;
  multiplier: Prisma.Decimal | number | null;
  fixedPriceCents: number | null;
}

export interface PricingConditions {
  /** 0 = Sunday … 6 = Saturday, in the VENUE's timezone. */
  dayOfWeek?: number[];
  /** { from: "18:00", to: "22:00" } — venue-local clock time. */
  timeRange?: { from: string; to: string };
  playerTags?: string[];
  membershipLevel?: string;
}

export interface PriceContext {
  basePriceCents: number;
  /** Venue-local day-of-week and clock times, resolved by the caller. */
  localDayOfWeek: number;
  localStartMinutes: number;
  localEndMinutes: number;
  playerTags?: readonly string[];
  membershipLevel?: string | null;
}

export interface RuleTraceEntry {
  ruleId: string;
  ruleName: string;
  priority: number;
  matched: boolean;
  reason: string;
}

export interface PriceResult {
  finalPriceCents: number;
  appliedRuleId: string | null;
  ruleTrace: RuleTraceEntry[];
}

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Does the rule's time window CONTAIN the whole booking?
 *
 * Deliberately containment, not overlap. A "peak 18:00–22:00" surcharge
 * must not be charged on a booking that runs 17:00–18:30 and merely clips
 * the edge of peak — the club would be charging peak rates for an off-peak
 * hour, and the player would (rightly) call it a bug.
 *
 * The rule must span the ENTIRE booking to apply.
 */
function timeRangeCovers(
  range: { from: string; to: string },
  startMinutes: number,
  endMinutes: number,
): boolean {
  const from = parseClock(range.from);
  const to = parseClock(range.to);
  return startMinutes >= from && endMinutes <= to;
}

function evaluate(
  conditions: PricingConditions,
  ctx: PriceContext,
): { matched: boolean; reason: string } {
  if (conditions.dayOfWeek && conditions.dayOfWeek.length > 0) {
    if (!conditions.dayOfWeek.includes(ctx.localDayOfWeek)) {
      return { matched: false, reason: `dayOfWeek ${ctx.localDayOfWeek} not in rule` };
    }
  }

  if (conditions.timeRange) {
    if (!timeRangeCovers(conditions.timeRange, ctx.localStartMinutes, ctx.localEndMinutes)) {
      return {
        matched: false,
        reason: `booking is not fully inside ${conditions.timeRange.from}–${conditions.timeRange.to}`,
      };
    }
  }

  if (conditions.playerTags && conditions.playerTags.length > 0) {
    const tags = ctx.playerTags ?? [];
    const hit = conditions.playerTags.some((t) => tags.includes(t));
    if (!hit) {
      return {
        matched: false,
        reason: `player lacks any of [${conditions.playerTags.join(', ')}]`,
      };
    }
  }

  if (conditions.membershipLevel) {
    if (ctx.membershipLevel !== conditions.membershipLevel) {
      return { matched: false, reason: `membership is not ${conditions.membershipLevel}` };
    }
  }

  return { matched: true, reason: 'all conditions satisfied' };
}

export function computePrice(rules: readonly PricingRuleRow[], ctx: PriceContext): PriceResult {
  // Highest priority wins. Sort explicitly rather than trusting the caller's
  // ORDER BY — a repository refactor that drops the order clause would
  // silently start applying the wrong price, and nothing would fail.
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);

  const ruleTrace: RuleTraceEntry[] = [];
  let applied: PricingRuleRow | null = null;

  for (const rule of ordered) {
    const conditions = (rule.conditionsJson ?? {}) as PricingConditions;
    const { matched, reason } = evaluate(conditions, ctx);

    ruleTrace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      priority: rule.priority,
      matched: matched && applied === null,
      reason: applied !== null ? 'skipped — a higher-priority rule already matched' : reason,
    });

    if (matched && applied === null) applied = rule;
  }

  if (!applied) {
    return { finalPriceCents: ctx.basePriceCents, appliedRuleId: null, ruleTrace };
  }

  // A fixed price OVERRIDES a multiplier when both are set. "€40 flat on
  // holidays" must not also get the ×1.5 weekend surcharge stapled on.
  if (applied.fixedPriceCents != null) {
    return {
      finalPriceCents: applied.fixedPriceCents,
      appliedRuleId: applied.id,
      ruleTrace,
    };
  }

  const multiplier = applied.multiplier == null ? 1 : Number(applied.multiplier);

  return {
    // ═══ ROUND, AND ROUND THE RIGHT NUMBER ═══
    //
    // Round rather than floor: flooring systematically under-charges by up to
    // a cent on every booking, and it never reconciles.
    //
    // Rounding alone is not enough. `1290 * 1.15` is 1483.4999999999998 in
    // binary floating point, so `Math.round` yields 1483 where the exact
    // answer is 1483.5 → 1484: a EUR 12.90 court with a x1.15 rule
    // under-charges a cent. Measured across 30 856 realistic
    // (price, multiplier) pairs, 472 disagree with exact arithmetic.
    //
    // `toFixed(6)` collapses the representation error — six places is far more
    // than any real multiplier carries and far fewer than the error — so the
    // half-cent is decided on the value the arithmetic meant rather than on
    // the value the float happened to hold.
    //
    // Deliberately NOT `basePriceCents * round(multiplier * 100) / 100`, which
    // would be exact for the `Decimal(4,2)` column but silently narrow this
    // pure function's contract: its own tests exercise 1.115 and 1.0004.
    finalPriceCents: Math.round(Number((ctx.basePriceCents * multiplier).toFixed(6))),
    appliedRuleId: applied.id,
    ruleTrace,
  };
}

/**
 * Price a whole booking span, the way the booking route actually prices it.
 *
 * ═══ WHY THIS EXISTS, AND WHY IT LIVES HERE ═══
 *
 * `basePriceCents` is the price of ONE `minBookingMinutes` block, not of a
 * booking. `quoteBooking` therefore decomposes a span into units and prices
 * each one separately — a 120-minute booking at a 60-minute court is two
 * `computePrice` calls, not one.
 *
 * The admin pricing preview called `computePrice` once for the whole span and
 * showed half the real price, because the decomposition was inlined in
 * `availability.ts` where a client component could not reach it. That is the
 * drift the preview's own docblock warned about, arrived at by calling the
 * right engine at the wrong granularity rather than by reimplementing it.
 *
 * So the loop lives here, in the pure module — no Prisma runtime import, only
 * an erased type — and both callers use it. A preview that disagreed with the
 * engine would now require changing this function, which changes both.
 *
 * ═══ WHY THE PER-UNIT TRACES COME BACK ═══
 *
 * A rule can win one unit and lose another: a 17:00–19:00 booking is off-peak
 * for its first hour and peak for its second. "Did this rule apply?" has no
 * single answer for a span, and the screen exists to answer exactly that — so
 * it gets every unit's trace and decides how to say it.
 */
export interface SpanPriceResult {
  finalPriceCents: number;
  units: number;
  /** Distinct rule ids that won at least one unit, in unit order. */
  appliedRuleIds: string[];
  unitTraces: RuleTraceEntry[][];
}

export function computeSpanPrice(
  rules: readonly PricingRuleRow[],
  ctx: Omit<PriceContext, 'localEndMinutes'> & { unitMinutes: number; units: number },
): SpanPriceResult {
  let finalPriceCents = 0;
  const appliedRuleIds: string[] = [];
  const unitTraces: RuleTraceEntry[][] = [];

  for (let u = 0; u < ctx.units; u++) {
    const unitStart = ctx.localStartMinutes + u * ctx.unitMinutes;
    const result = computePrice(rules, {
      basePriceCents: ctx.basePriceCents,
      localDayOfWeek: ctx.localDayOfWeek,
      localStartMinutes: unitStart,
      localEndMinutes: unitStart + ctx.unitMinutes,
      playerTags: ctx.playerTags,
      membershipLevel: ctx.membershipLevel,
    });

    finalPriceCents += result.finalPriceCents;
    unitTraces.push(result.ruleTrace);
    if (result.appliedRuleId && !appliedRuleIds.includes(result.appliedRuleId)) {
      appliedRuleIds.push(result.appliedRuleId);
    }
  }

  return { finalPriceCents, units: ctx.units, appliedRuleIds, unitTraces };
}
