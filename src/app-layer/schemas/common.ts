import type { SportType } from '@prisma/client';
import { z } from 'zod';

import { SPORTS } from '@/lib/sports/registry';

/**
 * Shared Zod primitives.
 *
 * These exist so that "a court id" means the same thing on every route. A
 * per-route `z.string()` is how a slug ends up where an id belongs.
 */

/// Prisma ids are cuid, not uuid — see docs/implementation-notes/p04.
export const cuidSchema = z.string().regex(/^c[a-z0-9]{20,32}$/i, 'Expected a cuid');

export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens only');

/// Money is ALWAYS integer cents. A float price is a rounding bug waiting
/// for a busy Saturday.
export const pricingCentsSchema = z.number().int().min(0).max(10_000_00);

export const currencySchema = z.enum(['EUR', 'BGN']);

export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Not a valid IANA timezone' },
);

/**
 * DERIVED from the registry, never hand-listed.
 *
 * This was a literal array of seven sports while the Prisma enum and the
 * registry had sixteen. Nothing failed: the nine missing ones — CHESS,
 * PICKLEBALL, RUNNING, CYCLING, HANDBALL, FOOTBALL, BEACH_TENNIS,
 * BEACH_VOLLEYBALL, ESPORTS — were simply rejected as invalid input by
 * every filter that validates a sport, for a sport the database stores
 * happily and the UI offers.
 *
 * A hand-written copy of an enum has no way to fail loudly. It is always
 * correct on the day it is written and silently wrong from the next
 * migration onward, which is why this is derived rather than corrected.
 *
 * `SPORTS` is typed `Record<SportType, SportConfig>`, so a sport added to
 * the Prisma schema without a registry entry is a COMPILE error, and this
 * enum inherits that guarantee. The cast is the one unavoidable step:
 * `Object.keys` is typed `string[]`, and `z.enum` wants a non-empty tuple.
 *
 * Importing the registry keeps this module free of a RUNTIME Prisma
 * dependency — `registry.ts` imports `SportType` as a type only, so
 * nothing here drags the client into a browser bundle.
 */
export const sportSchema = z.enum(Object.keys(SPORTS) as [SportType, ...SportType[]]);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
