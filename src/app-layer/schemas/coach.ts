import { z } from 'zod';

import { cuidSchema, paginationSchema, sportSchema } from './common';

/** P08+ fills these in as the use cases land. */
export const coachIdSchema = z.object({ coachId: cuidSchema });
export const listCoachsSchema = paginationSchema.extend({
  sport: sportSchema.optional(),
});

/**
 * `POST /api/v1/coaches/{slug}/lessons` (#548). The player names the coach's
 * link (the coach at one venue), a start and a length; the court is chosen
 * for them, and the price is the server's.
 */
export const bookLessonBodySchema = z.object({
  linkId: cuidSchema,
  startTs: z.iso.datetime({ offset: true }),
  minutes: z.number().int().min(15).max(240),
  sport: sportSchema.optional(),
  notes: z.string().trim().max(500).nullish(),
});
export type BookLessonBody = z.infer<typeof bookLessonBodySchema>;
