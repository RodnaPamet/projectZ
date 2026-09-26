import { z } from 'zod';

import { cuidSchema, paginationSchema, sportSchema } from './common';

export const courtIdSchema = z.object({ courtId: cuidSchema });
export const listCourtsSchema = paginationSchema.extend({
  sport: sportSchema.optional(),
});

/**
 * ═══ WHY THE BOOKING-WINDOW FIELDS ARE VALIDATED TOGETHER ═══
 *
 * `minBookingMinutes`, `maxBookingMinutes` and `slotStepMinutes` are three
 * independent columns that only make sense as a set. A court with min 90 and
 * max 60 offers no bookable span at all, and a step that does not divide the
 * window produces a grid with a permanent gap at the end of the day — both
 * render as "this court has no availability", which reads like a bug in the
 * calendar rather than a value somebody typed.
 *
 * `superRefine` rather than three `.refine()`s so every violation is reported
 * at once; a form that surfaces one error per submit takes three round trips
 * to fix three fields.
 */
const bookingWindow = {
  minBookingMinutes: z
    .number()
    .int()
    .min(15)
    .max(24 * 60),
  maxBookingMinutes: z
    .number()
    .int()
    .min(15)
    .max(24 * 60),
  slotStepMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
};

function checkWindow(
  v: { minBookingMinutes: number; maxBookingMinutes: number; slotStepMinutes: number },
  ctx: z.RefinementCtx,
) {
  if (v.maxBookingMinutes < v.minBookingMinutes) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxBookingMinutes'],
      message: 'maxBookingMinutes must not be below minBookingMinutes',
    });
  }
  if (v.minBookingMinutes % v.slotStepMinutes !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['slotStepMinutes'],
      message: 'minBookingMinutes must be a whole number of slot steps',
    });
  }
}

export const courtCreateSchema = z
  .object({
    venueId: cuidSchema,
    name: z.string().trim().min(1).max(80),
    sport: sportSchema,
    resourceType: z
      .enum(['COURT', 'FIELD', 'TABLE', 'BOARD_TABLE', 'LOBBY', 'ROUTE'])
      .default('COURT'),
    surface: z.enum(['CLAY', 'HARD', 'GRASS', 'ARTIFICIAL_GRASS', 'CARPET', 'WOOD', 'CONCRETE']),
    isIndoor: z.boolean().default(false),
    capacity: z.number().int().min(1).max(64).default(4),
    /**
     * Integer cents. Never a float — `money-integer-discipline` fails the build
     * on a money field typed as one, because 0.1 + 0.2 in a currency column is
     * a support ticket nobody can reproduce.
     */
    basePriceCents: z.number().int().min(0).max(1_000_000),
    ...bookingWindow,
  })
  .superRefine(checkWindow);

export const courtUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    sport: sportSchema,
    surface: z.enum(['CLAY', 'HARD', 'GRASS', 'ARTIFICIAL_GRASS', 'CARPET', 'WOOD', 'CONCRETE']),
    isIndoor: z.boolean(),
    capacity: z.number().int().min(1).max(64),
    basePriceCents: z.number().int().min(0).max(1_000_000),
    ...bookingWindow,
  })
  .superRefine(checkWindow);

export type CourtCreate = z.infer<typeof courtCreateSchema>;
export type CourtUpdate = z.infer<typeof courtUpdateSchema>;
