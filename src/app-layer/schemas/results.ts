import { z } from 'zod';

/**
 * Request bodies of a booking's result (#575). The use case checks the sides
 * against the booking's players and the score against the sport
 * (`@/lib/ranking/score`); the schemas only bound the shapes, so nothing huge
 * reaches either.
 */
const userId = z.string().min(1).max(64);
const side = z.array(userId).min(1).max(11);
const pair = z.tuple([z.number().int().min(0).max(300), z.number().int().min(0).max(300)]);

/** `POST /me/bookings/{id}/result` and the club's own entry. */
export const reportResultBodySchema = z
  .object({
    sides: z.array(side).length(2),
    score: z.array(pair).min(1).max(5),
  })
  .strict();

/** `POST /me/results/{id}/reject`: why, for the club, if the player says. */
export const rejectResultBodySchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();

/** `POST /t/{slug}/admin/results/{id}/decide`. */
export const decideResultBodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('confirm'),
      sides: z.array(side).length(2).optional(),
      score: z.array(pair).min(1).max(5).optional(),
    })
    .strict(),
  z.object({ action: z.literal('void') }).strict(),
]);
