import { isSportKey } from '@/lib/sports/registry';

/**
 * /venues' URL filters, read the same way by the server page and the client
 * list (#357). No directive: the server page CALLS this, and every export of a
 * `'use client'` module is a client reference that throws when called
 * (tests/guardrails/client-boundary.test.ts).
 */

/** The filters `GET /api/v1/venues` is keyed on here. Absent means unfiltered. */
export type VenueFilters = Partial<Record<'q' | 'city' | 'sport', string>>;

export const FILTER_NAMES = ['q', 'city', 'sport'] as const;

/**
 * The filters as the URL states them: empty is absent (as `query()` in keys.ts
 * treats it), values are trimmed, and a `sport` outside the enum is DROPPED
 * (#334). A hand-edited `?sport=foo` lists every venue rather than reaching
 * Prisma as an invalid enum (a 500), and the client keys the same read the
 * server rendered — never one the API would answer with a 400.
 */
export function filtersFromParams(
  params: { get(name: string): string | null | undefined } | null,
): VenueFilters {
  const out: VenueFilters = {};
  for (const k of FILTER_NAMES) {
    const v = params?.get(k)?.trim() ?? '';
    if (v === '') continue;
    if (k === 'sport' && !isSportKey(v)) continue;
    out[k] = v;
  }
  return out;
}
