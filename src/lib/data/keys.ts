/**
 * Every `/api/v1/…` URL the browser uses, and the SWR keys built from them.
 *
 * ═══ THE ONLY PLACE A v1 URL IS SPELLED ═══
 *
 * `tests/guardrails/data-layer-discipline.test.ts` refuses a `/api/v1/` string
 * in client code anywhere else. Two reasons, both learned elsewhere:
 *
 *   - A key IS the cache identity. Two components that spell the same read
 *     differently (`?q=a&city=b` vs `?city=b&q=a`) hold two copies of one
 *     answer, and a mutation that refreshes one leaves the other stale. So
 *     params are SORTED and empty ones dropped, here, once.
 *   - Everything the server filters on is IN the key. A param that changes the
 *     answer but not the key serves one query's result for another.
 *
 * ═══ NO DIRECTIVE, ON PURPOSE ═══
 *
 * A server component may build a key (to pass a `fallback`, or a href), and a
 * `'use client'` module's plain functions cannot be called from the server —
 * see tests/guardrails/client-boundary.test.ts and the 500 it records.
 *
 * ═══ KEYS ARE URLS ═══
 *
 * A key is the exact URL `v1Fetch` requests, so the fetcher needs no lookup
 * table, a matcher can select by prefix, and the network panel shows the cache.
 * A cursor list is a `getKey(index, previousPage)` for `useSWRInfinite`; its
 * first page is the list's identity (`unstable_serialize(getKey)`).
 *
 * The user is NOT in the key, deliberately: `/t/{slug}/bookings` means "mine".
 * What stops one account's answer landing under another's page is the
 * `x-playerz-viewer` check (src/app/api/v1/_lib/request-guard.ts), and the
 * cache never outlives the tab — there is no persistent provider.
 */

const BASE = '/api/v1';

/** The `data` of a v1 cursor page. Mirrors `Page<T>` in src/app/api/v1/_lib/envelope.ts. */
export interface V1Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** A `useSWRInfinite` key function over a v1 cursor list. */
export type InfiniteKey<T = unknown> = (index: number, previous: V1Page<T> | null) => string | null;

type Param = string | number | boolean | null | undefined;
type Params = Readonly<Record<string, Param>>;

const seg = (s: string) => encodeURIComponent(s);

/** `?a=1&b=2`, sorted by name, with null, undefined and '' left out. */
function query(params: Params = {}): string {
  const entries = Object.entries(params)
    .filter((e): e is [string, string | number | boolean] => e[1] != null && e[1] !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, String(v)]);
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries).toString()}`;
}

/**
 * A cursor list. Page 0 is the base query; page n follows page n-1's
 * `nextCursor`, and a null cursor ends the list.
 */
function paged<T>(path: string, params: Params = {}): InfiniteKey<T> {
  return (index, previous) => {
    if (index === 0) return `${path}${query(params)}`;
    if (!previous?.nextCursor) return null;
    return `${path}${query({ ...params, cursor: previous.nextCursor })}`;
  };
}

/** What `GET /venues` filters on — see src/app/api/v1/venues/route.ts. */
export interface VenueSearchParams {
  q?: string;
  city?: string;
  sport?: string;
  indoor?: boolean;
  maxPrice?: number;
  limit?: number;
}

/** Reads: SWR keys. */
export const KEYS = {
  /** The caller's standing at a club. There is no club-less `/me` in v1 yet. */
  me: (slug: string) => `${BASE}/t/${seg(slug)}/me`,
  /** The caller's own bookings at a club, newest first, by cursor. */
  myBookings: (slug: string, params: { limit?: number } = {}) =>
    paged(`${BASE}/t/${seg(slug)}/bookings`, params),
  /**
   * The caller's own bookings at EVERY club, newest first, by cursor:
   * `GET /me/bookings` (T16), the list /me/bookings renders (T22). The
   * per-club `myBookings(slug)` above cannot be it — a person's list spans
   * clubs, and a native token does not carry the list of them.
   */
  meBookings: (params: { limit?: number } = {}) => paged(`${BASE}/me/bookings`, params),
  /** The public venue index, by cursor. */
  venues: (params: VenueSearchParams = {}) => paged(`${BASE}/venues`, { ...params }),
  /**
   * The review moderation queue. `reason` is part of the key because the server
   * records it with every page it serves (PLATFORM_MODERATION_QUEUE_READ): a
   * different reason is a different, separately audited read.
   */
  moderationCases: (params: { reason: string }) =>
    paged(`${BASE}/platform/moderation/cases`, params),
  /** The caller's second factor, and THIS session's step-up (#262). */
  mfaStatus: () => `${BASE}/me/mfa`,
} as const;

/** Writes: the URLs `useV1Mutation` posts to. */
export const V1 = {
  createBooking: (slug: string) => `${BASE}/t/${seg(slug)}/bookings`,
  cancelBooking: (slug: string, bookingId: string) =>
    `${BASE}/t/${seg(slug)}/bookings/${seg(bookingId)}/cancel`,
  review: (slug: string, bookingId: string) =>
    `${BASE}/t/${seg(slug)}/bookings/${seg(bookingId)}/review`,
  resolveCase: (caseId: string) => `${BASE}/platform/moderation/cases/${seg(caseId)}/resolve`,
  mfaEnrol: () => `${BASE}/me/mfa/enrolment`,
  mfaConfirm: () => `${BASE}/me/mfa/enrolment/confirm`,
  mfaStepUp: () => `${BASE}/me/mfa/step-up`,
  mfaRecoveryCodes: () => `${BASE}/me/mfa/recovery-codes`,
} as const;

/**
 * A matcher for `mutate(matcher)`: every PLAIN key under a prefix.
 *
 * SWR 2.4.2's matcher skips `$inf$` keys (config-context: `/^\$(inf|sub)\$/`),
 * so it never reaches a cursor list; those are refreshed through
 * `unstable_serialize(getKey)` — see use-v1-mutation.ts.
 */
export function keysUnder(prefix: string): (key: unknown) => boolean {
  return (key) => typeof key === 'string' && key.startsWith(prefix);
}

/** Every plain key that reads one club's data. */
export const clubKeys = (slug: string) => keysUnder(`${BASE}/t/${seg(slug)}/`);
