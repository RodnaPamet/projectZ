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
  /** The caller's standing at a club. */
  me: (slug: string) => `${BASE}/t/${seg(slug)}/me`,
  /**
   * The caller's account, at no club (T16): name, avatar, kind, and the sports
   * played with a level for each (#359). `PATCH` of the same URL writes it.
   */
  account: () => `${BASE}/me`,
  /**
   * The bell (#367): the caller's newest notifications and their unread
   * count, in one read. The header polls it.
   */
  notifications: () => `${BASE}/me/notifications${query({ limit: 20 })}`,
  /** Which emails the caller gets (#367). `PATCH` of the same URL writes it. */
  notificationSettings: () => `${BASE}/me/notification-settings`,
  /** The caller's own bookings at a club, newest first, by cursor. */
  myBookings: (slug: string, params: { limit?: number } = {}) =>
    paged(`${BASE}/t/${seg(slug)}/bookings`, params),
  /**
   * The caller's own bookings at EVERY club, newest first, by cursor:
   * `GET /me/bookings` (T16), the list /me/bookings renders (T22). The
   * per-club `myBookings(slug)` above cannot be it — a person's list spans
   * clubs, and a native token does not carry the list of them.
   */
  meBookings: (params: { limit?: number; when?: 'upcoming' | 'past' } = {}) =>
    paged(`${BASE}/me/bookings`, params),
  /** One of the caller's own bookings in full (#359): the booking detail page. */
  meBooking: (bookingId: string) => `${BASE}/me/bookings/${seg(bookingId)}`,
  /** Who plays a booking the caller is on (#358): names, avatars, places left. */
  meBookingParticipants: (bookingId: string) =>
    `${BASE}/me/bookings/${seg(bookingId)}/participants`,
  /** People the booker has played with who are not on this booking yet (#358). */
  meBookingCoPlayers: (bookingId: string) => `${BASE}/me/bookings/${seg(bookingId)}/co-players`,
  /** The public venue index, by cursor. */
  venues: (params: VenueSearchParams = {}) => paged(`${BASE}/venues`, { ...params }),
  /**
   * One venue's slots for one calendar day AT THE CLUB (`date=YYYY-MM-DD`,
   * resolved in the venue's zone by the server, never the device's): the venue
   * page's day picker (#355), and what the native app reads.
   */
  venueAvailability: (venueId: string, params: { date: string }) =>
    `${BASE}/venues/${seg(venueId)}/availability${query(params)}`,
  /**
   * The review moderation queue. `reason` is part of the key because the server
   * records it with every page it serves (PLATFORM_MODERATION_QUEUE_READ): a
   * different reason is a different, separately audited read.
   */
  moderationCases: (params: { reason: string }) =>
    paged(`${BASE}/platform/moderation/cases`, params),
  /** The caller's second factor, and THIS session's step-up (#262). */
  mfaStatus: () => `${BASE}/me/mfa`,
  /** The club's players matching a phone, name or email — the desk's "link to a player" (#364). */
  deskCustomers: (slug: string, q: string) =>
    `${BASE}/t/${seg(slug)}/admin/customers${query({ q })}`,
  /** A desk booking or series' quote and clashes (#364). */
  deskPreview: (
    slug: string,
    params: {
      resourceId: string;
      date: string;
      startTime: string;
      durationMinutes: number;
      weeks?: number;
      until?: string;
    },
  ) => `${BASE}/t/${seg(slug)}/admin/desk-bookings/preview${query({ ...params })}`,
  deskBooking: (slug: string, bookingId: string) =>
    `${BASE}/t/${seg(slug)}/admin/desk-bookings/${seg(bookingId)}`,
  /**
   * Every club's fee for a month (#372), for the owner to invoice from. The
   * reason is in the key for the same reason as the moderation queue's: the
   * server audits each read with it.
   */
  platformFees: (params: { month: string; reason: string }) =>
    `${BASE}/platform/fees${query(params)}`,
  /** One club's statement, from the platform (#372). */
  platformClubStatement: (clubId: string, params: { month: string; reason: string }) =>
    `${BASE}/platform/fees/${seg(clubId)}/statement${query(params)}`,
} as const;

/** Writes: the URLs `useV1Mutation` posts to. */
export const V1 = {
  createBooking: (slug: string) => `${BASE}/t/${seg(slug)}/bookings`,
  cancelBooking: (slug: string, bookingId: string) =>
    `${BASE}/t/${seg(slug)}/bookings/${seg(bookingId)}/cancel`,
  review: (slug: string, bookingId: string) =>
    `${BASE}/t/${seg(slug)}/bookings/${seg(bookingId)}/review`,
  resolveCase: (caseId: string) => `${BASE}/platform/moderation/cases/${seg(caseId)}/resolve`,
  /** `PATCH`: the display name and the sports with their levels (#359). */
  updateAccount: () => `${BASE}/me`,
  /** `POST { ids }`: the bell's rows the caller has now seen (#367). */
  markNotificationsRead: () => `${BASE}/me/notifications/read`,
  /** `PATCH { email: { … } }`: switch an email category (#367). */
  updateNotificationSettings: () => `${BASE}/me/notification-settings`,
  /** `POST` a new invite link; `DELETE` stops every live one (#358). */
  bookingInviteLinks: (bookingId: string) => `${BASE}/me/bookings/${seg(bookingId)}/invite-links`,
  /** `POST { userId }`: the booker adds a co-player (#358). */
  addBookingPlayer: (bookingId: string) => `${BASE}/me/bookings/${seg(bookingId)}/participants`,
  /** `DELETE`: the booker removes a player (#358). */
  removeBookingPlayer: (bookingId: string, participantId: string) =>
    `${BASE}/me/bookings/${seg(bookingId)}/participants/${seg(participantId)}`,
  /** `DELETE`: an added player leaves (#358). */
  leaveBooking: (bookingId: string) => `${BASE}/me/bookings/${seg(bookingId)}/participation`,
  /** `POST { token }`: join the booking behind an invite link (#358). */
  acceptBookingInvite: () => `${BASE}/booking-invites/accept`,
  /** `POST { kind }`: "Играч или треньор?", once (#360). */
  chooseAccountKind: () => `${BASE}/me/account-kind`,
  mfaEnrol: () => `${BASE}/me/mfa/enrolment`,
  mfaConfirm: () => `${BASE}/me/mfa/enrolment/confirm`,
  mfaStepUp: () => `${BASE}/me/mfa/step-up`,
  mfaRecoveryCodes: () => `${BASE}/me/mfa/recovery-codes`,
  createDeskBooking: (slug: string) => `${BASE}/t/${seg(slug)}/admin/desk-bookings`,
  updateDeskBooking: (slug: string, bookingId: string) =>
    `${BASE}/t/${seg(slug)}/admin/desk-bookings/${seg(bookingId)}`,
  createSeries: (slug: string) => `${BASE}/t/${seg(slug)}/admin/booking-series`,
  cancelSeries: (slug: string, seriesId: string) =>
    `${BASE}/t/${seg(slug)}/admin/booking-series/${seg(seriesId)}/cancel`,
  /**
   * A club's statement as a CSV file (#372): an `<a download>` href, not an
   * SWR key, because the browser saves it rather than this app reading it.
   */
  clubStatementCsv: (slug: string, month: string) =>
    `${BASE}/t/${seg(slug)}/admin/statements/csv${query({ month })}`,
  /** The same file from the platform, which audits the download with `reason` (#372). */
  platformClubStatementCsv: (clubId: string, params: { month: string; reason: string }) =>
    `${BASE}/platform/fees/${seg(clubId)}/statement/csv${query(params)}`,
  /** `PUT { feePercent, feeStartsOn, reason }`: a club's fee terms (#372). */
  clubFeeTerms: (clubId: string) => `${BASE}/platform/fees/${seg(clubId)}/terms`,
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
