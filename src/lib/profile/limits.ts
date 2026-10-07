import type { SportType } from '@prisma/client';

import { bookableSports } from '@/lib/sports/registry';

/**
 * What a player's profile may hold (#359), shared by `PATCH /api/v1/me`'s zod
 * schema and the profile sections. Kept apart from the schema so the client
 * gets these numbers without zod in its bundle; `registry.ts` imports Prisma's
 * enum as a type only, so neither does this drag in a database client.
 */

/** The self-declared level's range (Q37). The database holds the same as a CHECK (P43). */
export const MIN_SPORT_LEVEL = 1;
export const MAX_SPORT_LEVEL = 7;
export const SPORT_LEVELS: readonly number[] = Array.from(
  { length: MAX_SPORT_LEVEL - MIN_SPORT_LEVEL + 1 },
  (_, i) => MIN_SPORT_LEVEL + i,
);

/** A display name's length, after trimming and collapsing spaces. */
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 60;

/**
 * The sports a player can pick: the registry's bookable ones that take a
 * self-declared level (`selfDeclaredLevel`). The pilot is every court sport;
 * running and cycling are not booked, and karting is booked but has no level
 * (the registry says why). Derived, never hand-listed, for the reason
 * `sportSchema` in schemas/common.ts gives — so `PATCH /me` refuses KARTING
 * with the same list the profile sheet offers.
 */
export const PROFILE_SPORTS: readonly SportType[] = bookableSports()
  .filter((s) => s.selfDeclaredLevel)
  .map((s) => s.key);
