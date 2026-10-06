import type { SportType } from '@prisma/client';

import { ValidationError } from '@/lib/errors/types';
import { isSportKey } from '@/lib/sports/registry';

/**
 * `?sport=` on the public venue reads (#334), checked before it reaches Prisma.
 *
 * It used to be cast with `as never` and handed straight to the query, so an
 * unknown value — `?sport=foo`, on a public, unauthenticated URL — reached
 * Prisma as an invalid enum and came back as a 500. A client sending a sport
 * this server does not know has a bug (or an older enum), and a 400 naming the
 * parameter tells it so; silently dropping the filter would answer a different
 * question than the one asked.
 *
 * Absent or empty is "no filter". The `/venues` page does not call this: a
 * hand-edited URL there drops the filter instead (see its `filters`).
 */
export function sportParam(raw: string | null): SportType | undefined {
  if (raw === null || raw === '') return undefined;
  if (!isSportKey(raw)) {
    throw new ValidationError(`Invalid sport: ${raw.slice(0, 40)}`, { field: 'sport' });
  }
  return raw;
}
