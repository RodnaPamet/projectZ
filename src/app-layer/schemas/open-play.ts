import { z } from 'zod';

import { OPEN_PLAY_NOTE_MAX } from '@/lib/open-play/limits';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';

/**
 * Request bodies for open play (#376). All `.strict()`: an unknown property is
 * a 400 naming it, never silently ignored.
 *
 * A note is bounded here by its raw length and again by the use case after
 * sanitising, which is what the CHECK in P61 holds.
 */

const level = z.number().int().min(MIN_SPORT_LEVEL).max(MAX_SPORT_LEVEL).nullable().optional();
const note = z
  .string()
  .max(OPEN_PLAY_NOTE_MAX * 2)
  .nullable()
  .optional();

/**
 * `PUT /me/bookings/{id}/game`: open the booking to other players, change
 * what it asks for, or reopen it. `spots` is how many MORE players are wanted
 * now, at most the court's free places (the use case checks that).
 */
export const openGameBodySchema = z
  .object({
    spots: z.number().int().min(1).max(64),
    levelMin: level,
    levelMax: level,
    note,
  })
  .strict()
  .refine((b) => b.levelMin == null || b.levelMax == null || b.levelMin <= b.levelMax, {
    message: 'levelMin is above levelMax',
    path: ['levelMin'],
  });

/** `POST /games/{id}/requests`: ask to join, with an optional note to the booker. */
export const askToJoinBodySchema = z.object({ note }).strict();
