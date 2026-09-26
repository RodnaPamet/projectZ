import { z } from 'zod';

import { cuidSchema } from './common';

/**
 * A pricing rule, as the admin screen submits it.
 *
 * ═══ THE SHAPE IS A JSON COLUMN, AND THAT IS THE RISK ═══
 *
 * `PricingRule.conditionsJson` is `Json`, so Postgres will store any object at
 * all. A rule with `{ dayofweek: [1] }` — lower-case w — is accepted by the
 * database, ignored by `computePrice`, and shows in the list looking exactly
 * like a rule that works. The club then wonders why Monday is not cheaper.
 *
 * This schema is the only thing standing between a typo and that, so it is
 * `.strict()`: an unrecognised key is an error rather than silently dropped.
 */
const conditions = z
  .object({
    /** 0 = Sunday … 6 = Saturday, in the VENUE's timezone. */
    dayOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    timeRange: z
      .object({
        from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .optional(),
    playerTags: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
    membershipLevel: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.timeRange && v.timeRange.from >= v.timeRange.to) {
      // Lexical comparison is correct for zero-padded HH:MM, and the regex
      // above guarantees that shape. An inverted window matches nothing, so
      // the rule would simply never fire — the silent kind of wrong.
      ctx.addIssue({
        code: 'custom',
        path: ['timeRange', 'to'],
        message: 'timeRange.to must be after timeRange.from',
      });
    }
  });

export const pricingRuleWriteSchema = z
  .object({
    resourceId: cuidSchema,
    name: z.string().trim().min(1).max(80),
    /**
     * Higher wins, and `computePrice` sorts descending. Ties are resolved by
     * whatever order the sort happens to produce, so the form nudges towards
     * distinct values rather than pretending it is deterministic.
     */
    priority: z.number().int().min(0).max(1000),
    conditions,
    /** Either a multiplier or a fixed price — never both, never neither. */
    multiplier: z.number().min(0).max(10).nullable(),
    fixedPriceCents: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .superRefine((v, ctx) => {
    const has = (x: unknown) => x !== null && x !== undefined;
    if (has(v.multiplier) === has(v.fixedPriceCents)) {
      ctx.addIssue({
        code: 'custom',
        path: ['multiplier'],
        message: has(v.multiplier)
          ? 'A rule sets either a multiplier or a fixed price, not both'
          : 'A rule must set either a multiplier or a fixed price',
      });
    }
  });

export type PricingRuleWrite = z.infer<typeof pricingRuleWriteSchema>;
export type PricingConditionsInput = z.infer<typeof conditions>;
