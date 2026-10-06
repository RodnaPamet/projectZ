import type { SportType } from '@prisma/client';
import { z } from 'zod';

import {
  MAX_NAME_LENGTH,
  MAX_SPORT_LEVEL,
  MIN_NAME_LENGTH,
  MIN_SPORT_LEVEL,
  PROFILE_SPORTS,
} from '@/lib/profile/limits';

/**
 * The body of `PATCH /api/v1/me` (#359): the player's display name, and the
 * sports they play with a self-declared level for each (Q37).
 *
 * ═══ .strict(), ON PURPOSE ═══
 *
 * Unlike the booking body, an unknown property is a 400 here, not ignored.
 * This body writes the caller's own account row, which also holds `email`,
 * `accountKind`, `locale`, `avatarUrl` and the MFA secret. A client sending
 * `accountKind: "CLUB"` must be told no, loudly, rather than shown a 200 that
 * a reader of the logs could take for a change of kind. Nothing outside the
 * two fields below is ever read from the body: the use case is handed the
 * parsed value, never the raw JSON.
 *
 * Both fields are optional and at least one must be present. An absent field
 * is left as it is; `sports: []` clears the list.
 */

const profileSportSchema = z.enum(PROFILE_SPORTS as [SportType, ...SportType[]]);

/**
 * A name a person would write: letters in any script, spaces, and the
 * punctuation names use (hyphen, apostrophe, dot). No control or invisible
 * characters, no markup, and at least one letter: a name of dots is not one.
 */
const NAME_CHARS = /^[\p{L}\p{M}' .’-]+$/u;

export const displayNameSchema = z
  .string()
  .transform((s) => s.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(MIN_NAME_LENGTH)
      .max(MAX_NAME_LENGTH)
      .regex(NAME_CHARS, 'Letters, spaces, hyphens, apostrophes and dots only')
      .regex(/\p{L}/u, 'At least one letter'),
  );

export const sportLevelSchema = z
  .object({
    sport: profileSportSchema,
    level: z.number().int().min(MIN_SPORT_LEVEL).max(MAX_SPORT_LEVEL),
  })
  .strict();

export const updateMeBodySchema = z
  .object({
    name: displayNameSchema.optional(),
    sports: z
      .array(sportLevelSchema)
      .max(PROFILE_SPORTS.length)
      .refine((list) => new Set(list.map((s) => s.sport)).size === list.length, {
        message: 'Each sport at most once',
      })
      .optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.sports !== undefined, {
    message: 'Nothing to change: send `name`, `sports`, or both',
  });

export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;
