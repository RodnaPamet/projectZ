# Navigation policy: the router cache and prefetching

What the client router keeps, what it fetches ahead of a tap, and why. Set by T30 from
measurement (`docs/perf/README.md`), and pinned by
`tests/guardrails/router-cache-policy.test.ts`.

## The router cache: `staleTimes { dynamic: 30, static: 180 }`

`next.config.mjs`, `experimental.staleTimes` (Next 16.3.6; see
`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/staleTimes.md`).

- **`dynamic: 30`** covers every page the router navigated to and did not fully prefetch.
  That means every page in this app. The default is 0, so the cache kept nothing and every
  revisit paid a full round trip. On the phone profile that was about 200 ms on every warm
  step (PR #268's baseline). Since T12's `loading.tsx`, a revisit also paid React's 300 ms
  Suspense reveal throttle, which put warm steps at about 355 ms (#290). A revisit within
  30 s now renders from memory: no request, no fallback and no throttle.
- **`static: 180`** covers `prefetch={true}`, `router.prefetch` and the `loading.tsx`
  shells that an automatic prefetch fetches. The shells are the skeletons and are the same
  for every visit, so keeping them 3 minutes costs nothing. The default is 300 s. It is
  shortened because the one full-prefetch site (below) holds real content.
- **A write purges all of it.** A Server Action that calls `revalidatePath` or
  `revalidateTag` makes the router drop its whole cache and re-prefetch the links in the
  viewport. So does `router.refresh()`. Next 16.3.6 bumps a single global segment-cache
  version in `invalidateSegmentCacheEntries`, and the Server Action reducer calls
  `invalidateEntirePrefetchCache`. A write is therefore never followed by a stale screen.
  The price is that the next tap after a write is a cold tap again, and the
  `staff-write` journey measures it.
- **Other people's writes do not purge it.** The purge above is per browser. A player page
  revisited within 30 s (a venue's availability, say) can show slots that someone else has
  booked since. That is accepted: the database rejects an overlapping booking (`booking_no_overlap`), so a stale
  slot costs a rejected tap, never a double booking. The SWR-backed player surfaces also
  revalidate after paint. Only the diary, where staff act on what they see, refreshes itself
  (below).

### The diary refreshes itself

The club diary is the front desk's live view. Bookings arrive from phones all day, and a
diary served from the cache can be up to 30 s old. `useRefreshWhenStale`
(`src/lib/hooks/use-refresh-when-stale.ts`) takes the server's render time (`renderedAt`,
stamped by `calendar/diary-day.ts`). When the day on screen is **older than 10 s**
(`STALE_AFTER_MS`), it re-fetches **the day, not the route**: `useFreshDiaryDay` calls
`refreshDiaryDayAction`, a Server Action that builds the same `DiaryDay` the page renders
and returns it as data, and the grid swaps it in. It checks on mount, which covers a
revisit from the cache, and when the tab becomes visible again, which covers a tablet woken
after lunch. The cached grid stays on screen until the fresh day replaces it. The tab keeps
the newest day it fetched, so a later revisit inside the window paints that copy rather
than the older cached payload; a newer server payload (after a write) always wins.

**Why not `router.refresh()` (#314).** It was the first version, and it purged the whole
cache (above): every diary revisit after 10 s turned every other cached admin screen cold.
On the phone that took calendar → courts from 46 ms to 357 ms, and a member of staff who
takes more than 10 s over a loop always paid it. `revalidatePath` on the diary alone is no
better: Next 16.3.6 sends no path to the client (`addRevalidationHeader` in
`server/app-render/action-handler.js`), and the client's server-action reducer evicts the
BFCache and refreshes all dynamic data on any revalidation. The action is a pure read
instead: no `revalidatePath`, `revalidateTag` or `refresh()`, no cookie writes and no
redirect. With none of those the response carries no `x-action-revalidated`, the server
skips the page render (`skipPageRendering`), and the reducer returns the router state
unchanged. `tests/guardrails/router-cache-policy.test.ts` pins all of it.

Why 10 s still: a revisit within 10 s fetches nothing, and waiting the full 30 s would let
the diary lag by that much. Age is measured on the client's own clock from the moment this
browser first showed the payload. Subtracting the server's timestamp from the phone's
would refresh every visit on a phone whose clock runs ahead, and never on one whose clock
runs behind.

## Prefetching

| Where                                                          | Prefetch                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Club admin (nav, diary, every board)                           | **auto** (the default: omit the prop)                                   | Fetches each dynamic route down to its `loading.tsx`, so the tap paints the skeleton at once (T12), and the page itself is fetched on the tap. **Never `prefetch={true}`.** A fully prefetched diary lives under `static`, so it could be 180 s old on the tap. Every revalidating admin write would also re-prefetch each such link in the viewport, in full.                                                                                                                                                                                                                                                     |
| Player shell sidebar and drawer (#362)                         | **auto**                                                                | Every signed-in rail is the vendored `NavItem`, pinned to `prefetch="auto"`: Играй, Резервации, Профил and the platform pages a grant opens fetch down to their `loading.tsx` as the rail mounts. The full prefetch stays with the phone's tab bar.                                                                                                                                                                                                                                                                                                                                                                |
| Player bottom tab bar (T20, below `md`)                        | **`prefetch={true}`**, skipped under Save-Data                          | One of two full-prefetch sites. Its pages (`/venues`, `/me`) read through `/api/v1` and SWR and revalidate after paint, so a shell up to 180 s old is corrected on arrival. A thumb on a tab bar switches tabs constantly, so each switch is worth making instant. Under `navigator.connection.saveData` it falls back to auto. A club account wears its admin's bar on every page instead (#362).                                                                                                                                                                                                                 |
| Club admin bottom tab bar (#362, below `md`)                   | **auto**                                                                | The admin's links, on the shared bar: the club admin rule above applies. A club account wears this bar on public pages too (#362).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Anonymous home: the /venues CTA and the header's /login (#290) | **`prefetch={true}`** via `PublicPrefetchLink`, skipped under Save-Data | Measured on production, a first visit to either had its whole RSC answer at 73–112 ms and then waited for the 300 ms reveal throttle, painting at 322–362 ms. Fully prefetched, the tap renders from the router cache: no request, no skeleton, no throttle. The payloads are 1.4–2.4 KB and the same for every anonymous visitor. The guardrail pins the component to exactly these two links.                                                                                                                                                                                                                    |
| The venue cards on `/venues` (#403)                            | **auto**, and the skeleton preloads the page's JS chunk                 | A card's auto prefetch fetches the venue page's `loading.tsx`. Its real back link (`VenueBackLink`) is a client reference, and Turbopack maps every client reference in a route to the route's whole chunk list, so decoding the skeleton also fetches the page's JS chunk (about 12 KB gzip, immutable, once for all cards). Without it the chunk was requested only when the tap's RSC answer arrived, and on the phone it landed after the reveal throttle had released: the page painted at ~430 ms, ~380 ms with it. No route or server work is added. The owner approved the fetch on 6 October 2026 (#403). |
| Hover                                                          | **none**                                                                | No hover-only prefetch. Touch has no hover, and on the desktop the viewport prefetch already covers what hover would. `data-table.tsx`'s `onRowPrefetch` is vendored and unused. A consumer that wires it to `router.prefetch` fails the guardrail.                                                                                                                                                                                                                                                                                                                                                                |
| Dead links                                                     | **none: do not link**                                                   | A `<Link>` to a page that does not exist prefetches a 404 as it enters the viewport. Chrome never reports those as finished (#267). The club nav's open-play, coaches and my-bookings still do this (#260). Fix the destination or drop the link. Never paper over it with `prefetch={false}`.                                                                                                                                                                                                                                                                                                                     |
| Query-string links (the diary's `?day=` links)                 | **auto**                                                                | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`tests/guardrails/router-cache-policy.test.ts` fails on `prefetch={true}`, any computed
`prefetch={…}` value (only the literals `false`, `null` and `"auto"` pass), a bare
`prefetch` attribute or `router.prefetch(` anywhere under `src/` except two files.
`src/components/layout/tab-bar.tsx` is the shared bottom tab bar (#362): it forwards a
link's `fullPrefetch` to `<Link>`, and the guardrail pins `fullPrefetch` to
`BottomTabBar.tsx`, the player's bar (T20), which reads Save-Data through the same
`useSaveData` hook as `PublicPrefetchLink`. Its tabs are the player shell's own pages; it
has no admin tab since #362, when a club account started wearing its admin's bar
(`club-admin-tab-bar.tsx`) on every page, and that bar does not set it.
`src/components/layout/PublicPrefetchLink.tsx` is the public links' full prefetch, and the
guardrail also pins where it is used: once in `src/app/(home)/page.tsx` to `/venues`, and
once in `SiteHeader.tsx` (the signed-out header) to `/login`, nowhere else. The club admin, nav included, keeps
the auto prefetch. Its first visits take about 330–370 ms (a round trip plus the
throttle), and the owner accepted that cost on 1 October 2026 (#290).

### The query-string hang does not reproduce on 16.3.6

inflect-compliance hit a hang on Next 16.3.1 when it prefetched hrefs with a query string.
The diary's day links are `…/admin/calendar?day=YYYY-MM-DD`, so T30 re-tested them. The
staff journey's `calendar → next day` and `next day → today` steps ran with the default
auto prefetch, on both profiles, with the router cache on. That was 2 runs × 10 contexts ×
2 passes, 80 navigations per step. No settle timed out (the harness records every settle
that exceeds 20 s as a warning, and there were none). No `?day=` prefetch was left
pending, and every step committed. The links keep the default prefetch, and no guard rule
is added. If a later Next brings the hang back, the perf harness will show it first, as a
settle warning on those two steps.

## What this does not cover

- **A revisit after 30 s** is a cold tap again: a round trip plus, where the page has a
  `loading.tsx`, the 300 ms reveal throttle (#290). The perf harness clicks as soon as a
  page settles, so its warm pass revisits within a few seconds. Its warm rows show the
  cache-hit case, not the case of a person who spent a minute on a screen.
- **First visits** are unchanged, except to `/venues` and `/login` from the anonymous
  home page: the cache has nothing to serve yet. On the club admin this is the accepted
  ~330–370 ms (#290).
- **The player surfaces** get their cache from SWR (T20/T21), not from this policy.
