# The client data layer

How browser code reads and writes `/api/v1`. It lives in `src/lib/data`, it is playerz's own (no
inflect counterpart), and `tests/guardrails/data-layer-discipline.test.ts` makes it the only way.

Which surfaces use it is an owner decision: the **player** surfaces (`/venues`, `/me`) read v1
through SWR, because the native iOS client reads the same endpoints and one contract is cheaper
than two. **Club admin** stays on React Server Components and Server Actions. The moderation queue
is the first consumer, because it was the one browser caller of v1 already (raw `fetch` +
`useState`).

## The pieces

| File                        | What it is                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `keys.ts`                   | `KEYS` (reads: SWR keys) and `V1` (write URLs). The only place a `/api/v1/` string is built. No directive, so a server component can build a key too.                                            |
| `fetcher.ts`                | `v1Fetch<T>(url, init)`. Unwraps `{ data }`, returns `undefined` for 204 or an empty body, throws `ApiClientError`, marks the session and viewer stores, sends the viewer and `Idempotency-Key`. |
| `errors.ts`                 | `ApiClientError { status, code, message, requestId, details }`. `status` 0 / `NETWORK` when nothing answered. An abort is passed through untouched.                                              |
| `viewer.ts`                 | The one-way "this tab's account changed" store, the twin of `@/lib/auth/session-expiry` (vendored from inflect).                                                                                 |
| `provider.tsx`              | `DataProvider` (the one `SWRConfig`, mounted in `src/app/providers.tsx`) with the `sessionSeam` middleware; `ViewerScope` and `useViewerId`.                                                     |
| `use-v1-swr.ts`             | `useV1SWR`, `useV1SWRInfinite`, `needsSkeleton`.                                                                                                                                                 |
| `use-v1-mutation.ts`        | `useV1Mutation`: a write with an optional optimistic change to one cached read.                                                                                                                  |
| `viewer-changed-notice.tsx` | The notice for a changed account, beside inflect's `SessionExpiredNotice`.                                                                                                                       |

## Keys

- A key is the exact URL `v1Fetch` requests. Params are **sorted** and empty ones dropped, so one
  read has one spelling and one cache entry.
- Everything the server filters on is **in** the key. The moderation `reason` is a server-side
  param, so it is in the key: a different reason is a different, separately audited read.
- A cursor list is a `getKey(index, previousPage)` for `useSWRInfinite`; its identity is
  `unstable_serialize(getKey)`.
- The user is **not** in the key. `/t/{slug}/bookings` means "mine". What keeps one account's
  answer out of another's page is the viewer check below, and the cache never outlives the tab.

## Reads

Defaults, all overridable per hook:

| Option                                  | Value      | Why                                                                                  |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `revalidateOnFocus`, `OnReconnect`      | on         | Coming back to the tab shows today's bookings, not this morning's.                   |
| `dedupingInterval`                      | 5000 ms    | One read per glance; SWR's 2 s lets a quick tab-in/tab-out fire twice.               |
| `errorRetryCount`, `errorRetryInterval` | 2, 2000 ms | A blip recovers; an outage stops instead of retrying for as long as the tab is open. |
| `keepPreviousData`                      | true       | A filter change keeps the old list until the new one lands.                          |

`needsSkeleton(state)` is true only when loading with nothing to show. A revalidation with data on
screen never blanks it.

### `audited: true`

Some reads are records. Every page of the moderation queue writes a `PLATFORM_MODERATION_QUEUE_READ`
audit row with the reason the moderator gave (and `REASON_REQUIRED` without one), so a read SWR
starts on its own is an audit row nobody asked for, in somebody's name. `audited` turns off focus,
reconnect, stale-remount and first-page (`revalidateFirstPage`) revalidation and every retry, and it
wins over the hook's other options. Such a read happens only when a person asks for it.

## The two seams

`sessionSeam` is SWR **middleware**, not a config value. SWR merges a hook's options over the
provider's, so inflect's approach (overrides in `<SWRConfig value>`) loses to any hook that sets
`revalidateOnFocus: true`, and `useV1SWR` sets it by default. Middleware sees the merged config,
so its overrides are the last word.

Once the session has expired (a 401 on a session-bearing `/api/` path) or the viewer has changed
(a 409 `VIEWER_CHANGED`), every hook gets `refreshInterval 0`, focus, reconnect and stale
revalidation off, and `shouldRetryOnError false`. The error still lands, and `isPaused` is not used,
because SWR discards the error of a paused hook. A retry that was already scheduled before the
stop is dropped too: the seam wraps `onErrorRetry`, because SWR's retry timer revalidates without
looking at any of the options above.

The two notices are mounted once in `src/app/providers.tsx`. Both offer an action and never
redirect: a background revalidation must not throw away a half-typed review.

- **Session expired** (inflect's, vendored): a link to `/login`. Its padding is topped up with the
  safe-area inset from outside, because a vendored file's classes cannot change here.
- **Viewer changed** (playerz's): a reload, because the page, its server-rendered viewer id and
  every key have to be rebuilt for the account that is signed in now.

### The viewer

A page that shows a person's own data wraps it in `<ViewerScope viewerId={userId}>`, with the id
from the server render. Every `v1Fetch` beneath it sends `x-playerz-viewer`; the server answers 409
`VIEWER_CHANGED` when the live session belongs to someone else. #263 makes that routine: one person
holds a player account and a club account in one browser, one at a time.

## Writes

```ts
const resolve = useV1Mutation<
  { caseId: string; decision: Decision; note: string },
  unknown,
  V1Page<CaseItem>[]
>({
  url: ({ caseId }) => V1.resolveCase(caseId),
  body: ({ decision, note }) => ({ decision, note }),
  target: { infinite: list.mutate, getKey },
  update: (pages, { caseId }) =>
    pages.map((p) => ({ ...p, items: p.items.filter((i) => i.caseId !== caseId) })),
  fallback: [],
  revalidate: false,
  keepOnError: (e) => e.code === 'CASE_ALREADY_RESOLVED',
});
```

- **Target.** `{ key }` for a plain read, `{ infinite, getKey }` for a cursor list: the list's
  bound `mutate` and the `getKey` it was built with. SWR 2.4.2's matcher `mutate(fn)` skips `$inf$`
  keys outright, so a list can only be changed through its own `mutate`.
- **The updater sees what is on screen.** It gets SWR's _displayed_ value, or `fallback` on a cold
  cache, not the last committed one. Built on the committed value, a second change made while a
  first is in flight starts from before the first, and the first row comes back.
- **`populateCache: false`.** A write's response is not the list, so it never lands in the cache.
  `revalidate` (default true) decides whether the truth is re-read. An audited target passes false.
- **Rollback.** Any failure restores the list. `keepOnError` names the failures that mean "the world
  already agrees" (another moderator resolved the case): those stay removed and are still thrown,
  so the caller can say why.
- **A list's pages are cached twice**, once per page key and once as the `$inf$` array, and an
  optimistic change reaches only the array. On the next `setSize`, SWR would rebuild the array from
  the page keys (the removed row returns) and refetch page 0 because the copies disagree, which is
  an extra audit row on the moderation queue. So when a list has no write in flight, its page keys
  are rewritten from the array.
- **One id per trigger.** `crypto.randomUUID()` (or a `getRandomValues` v4 outside a secure
  context) is both the optimistic row's temp id and the `Idempotency-Key`. `retry()` re-sends the
  last failed trigger with the same id, so a retry after a lost response cannot book twice.
- **Related reads.** `related.keys` (a matcher, such as `clubKeys(slug)`) and `related.infinite`
  (`getKey`s) are refreshed after a success. Router-cache staleness (`staleTimes.dynamic = 30`, see
  `docs/perf`) is a separate layer: an SWR refresh does not touch it, and nothing here makes it
  longer.
- It never toasts. The caller shows the failure where the person is looking.

## On the server

Cookie-authenticated v1 writes lost the `Origin` check that Server Actions do for free. So
`contextFromRequest` now refuses a mutation that carries the session cookie with a `Sec-Fetch-Site`
other than `same-origin` or `none` (403 `CROSS_SITE_REQUEST`), and a request whose
`x-playerz-viewer` is not the signed-in user (409 `VIEWER_CHANGED`). Bearer requests, and requests
without the header, are unaffected. See `src/app/api/v1/_lib/request-guard.ts` and the "browser
requests" section of `openapi/NOTES.md`.

## Never

- A persistent cache. No `provider` on any `SWRConfig` in `src/`, and no persistence package
  (`tests/guardrails/pwa-safety.test.ts`). The cache is per device; the next person on a shared
  phone would see the last one's bookings.
- `swr` imported outside `src/lib/data` (one vendored, dead exception: `user-combobox.tsx`, which
  T28 deletes).
- `fetch()` in a `useEffect` in `src/app` or `src/components`.
- `signOut({ redirect: false })`, which leaves the page and its cache rendered for the account that
  just left.

## Tests

Every test gets its own cache (`<SWRConfig value={{ provider: () => new Map() }}>` inside
`DataProvider`) and a fake `fetch` (`tests/unit/data/fake-v1.ts`), because jsdom has none. SWR
re-renders only for the fields a render read, so a `renderHook` callback reads `data` itself when a
test inspects it after a write.
