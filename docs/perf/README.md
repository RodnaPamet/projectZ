# Navigation latency

How long it takes, from a tap, until the next screen's content is on the glass, and
what that tap costs on the wire. Measured before the perf programme changes anything,
so that every change after it has something to be judged against.

inflect-compliance, the product this UI and architecture are being ported from, feels
instant because of a client router cache (`staleTimes`), forced prefetch of the nav,
`loading.tsx` skeletons and SWR. It diagnosed its own slowness once (about 276 ms of
server response per navigation) and **never measured the result**. Its
`useReportWebVitals` cannot see an App Router navigation at all: a client-side
navigation has no LCP, no FCP and no navigation entry. This harness times navigations
in the page, from the click.

```sh
npm run perf:nav          # one run: reset and seed, build, serve, measure (about 12 min)
npm run perf:compare -- docs/perf/baseline-a56ea4f.json .perf/runs/<your run>.json
```

## The baseline: `a56ea4f`, 29 September 2026

`docs/perf/baseline-a56ea4f.json` holds two complete runs of the app at `a56ea4f`
(origin/main, #250), pooled. Each run used a fresh seed and a fresh server, and the
two started eleven minutes apart. Each cell below is 20 navigations: 10 fresh
browser contexts per run. **p95 of 20 samples is roughly the second-largest value.**
It says what a bad case looks like, not what the tail of a million users is.

A first pair of runs was taken at `4efe8c1`, and then #250 landed on main. It moves
tenant membership from the token to the database, on the path every club page
takes, so the baseline was taken again. `perf:compare` of those `4efe8c1` runs
against this baseline reports **0 faster and 0 slower, beyond noise**, in both
directions. That is the first real comparison, and the tool stays quiet about a
change that costs nothing.

### Time to the destination's key content, painted (ms, median / p75 / p95)

Soft navigations are clicks on the desktop and taps on the phone. "(full load)" is a
document load: the journey's entry page, or the landing after sign-in.

| Journey · step                                     |      Phone cold |      Phone warm |    Desktop cold |    Desktop warm |
| -------------------------------------------------- | --------------: | --------------: | --------------: | --------------: |
| public · load / (full load)                        | 746 / 768 / 816 |               — | 296 / 326 / 380 |               — |
| public · home → venues                             | 473 / 475 / 489 | 190 / 191 / 195 |    55 / 57 / 60 |    25 / 27 / 33 |
| public · venues → home                             | 199 / 202 / 205 | 194 / 200 / 205 |    27 / 28 / 29 |    28 / 29 / 30 |
| public · home → login                              | 373 / 374 / 379 | 194 / 202 / 203 |    28 / 29 / 31 |    28 / 29 / 30 |
| public · login → home (back)                       |    27 / 27 / 28 |    27 / 27 / 27 |    14 / 17 / 21 |    10 / 14 / 17 |
| player · load / (full load)                        | 718 / 726 / 792 |               — | 288 / 301 / 409 |               — |
| player · home → my bookings                        | 474 / 476 / 479 | 205 / 207 / 209 |    79 / 84 / 90 |    44 / 51 / 67 |
| player · my bookings → home                        | 202 / 204 / 205 | 195 / 201 / 205 |    35 / 42 / 44 |    37 / 42 / 44 |
| player · home → venues                             | 374 / 376 / 377 | 203 / 205 / 206 |    44 / 46 / 57 |    42 / 43 / 47 |
| player · venues → home                             | 197 / 203 / 204 | 194 / 198 / 203 |    28 / 35 / 40 |    28 / 35 / 39 |
| staff · load /t/sofia-padel-club (full load)       | 902 / 916 / 936 |               — | 462 / 485 / 574 |               — |
| staff · calendar → courts                          | 394 / 397 / 400 | 203 / 207 / 209 |    77 / 79 / 88 |    59 / 62 / 67 |
| staff · courts → pricing                           | 388 / 389 / 393 | 202 / 203 / 207 |    60 / 64 / 67 |    49 / 55 / 64 |
| staff · pricing → players                          | 430 / 434 / 436 | 261 / 265 / 270 |    79 / 84 / 86 |    60 / 63 / 79 |
| staff · players → staff                            | 542 / 546 / 561 | 367 / 371 / 381 |    85 / 93 / 95 |    78 / 83 / 93 |
| staff · staff → players (back)                     | 114 / 116 / 117 | 112 / 113 / 122 |    33 / 38 / 39 |    38 / 38 / 39 |
| staff · players → calendar                         | 216 / 220 / 223 | 217 / 222 / 226 |    49 / 52 / 61 |    50 / 56 / 66 |
| staff · calendar → next day                        | 212 / 213 / 215 | 205 / 208 / 210 |    53 / 54 / 60 |    52 / 56 / 67 |
| staff · next day → today                           | 213 / 214 / 216 | 210 / 212 / 214 |    45 / 54 / 60 |    48 / 53 / 62 |
| landing-player · /start → /me/bookings (full load) | 894 / 905 / 920 | 398 / 399 / 403 | 430 / 464 / 489 |  96 / 108 / 110 |
| landing-staff · /start → club calendar (full load) | 904 / 909 / 917 | 414 / 419 / 427 | 444 / 461 / 477 | 132 / 132 / 133 |

### What each navigation cost (phone, cold, medians)

"Waited for" means requests started between the tap and the commit that put the
destination in the DOM. The payload is the navigation's RSC response, or the final
HTML for a full load. It is shown as bytes on the wire (headers and compressed body)
and decoded bytes. Its first and last byte are in ms from the tap.

| Journey · step (phone, cold)                       | Requests waited for | KB waited for | Payload KB (wire / decoded) | Payload first byte | Payload last byte | First feedback | Feedback came from |
| -------------------------------------------------- | ------------------: | ------------: | --------------------------: | -----------------: | ----------------: | -------------: | ------------------ |
| public · load / (full load)                        |                  16 |         313.8 |                 13.1 / 38.1 |                155 |               165 |            746 | first paint        |
| public · home → venues                             |                   3 |          50.5 |                  4.4 / 14.8 |                194 |               196 |            445 | URL change         |
| public · venues → home                             |                   1 |           1.9 |                   1.9 / 3.3 |                186 |               189 |            191 | URL change         |
| public · home → login                              |                   3 |          15.7 |                   2.1 / 4.3 |                186 |               190 |            364 | URL change         |
| public · login → home (back)                       |                   0 |             0 |                           — |                  — |                 — |              1 | URL change         |
| player · load / (full load)                        |                  16 |         314.3 |                 13.6 / 38.8 |                154 |               166 |            718 | first paint        |
| player · home → my bookings                        |                   3 |          55.7 |                  6.1 / 23.5 |                192 |               198 |            446 | URL change         |
| player · my bookings → home                        |                   1 |           2.1 |                   2.1 / 3.7 |                187 |               189 |            192 | URL change         |
| player · home → venues                             |                   2 |           8.6 |                  4.6 / 15.3 |                185 |               189 |            356 | URL change         |
| player · venues → home                             |                   1 |           2.1 |                   2.1 / 3.7 |                185 |               187 |            189 | URL change         |
| staff · load /t/sofia-padel-club (full load)       |                  20 |         371.6 |                21.1 / 107.2 |                310 |               329 |            902 | first paint        |
| staff · calendar → courts                          |                   2 |           7.9 |                   2.2 / 5.8 |                184 |               192 |            366 | URL change         |
| staff · courts → pricing                           |                   3 |           9.4 |                   2.5 / 8.9 |                181 |               185 |            364 | URL change         |
| staff · pricing → players                          |                   2 |          10.4 |                  5.1 / 29.2 |                180 |               185 |            370 | URL change         |
| staff · players → staff                            |                   2 |          10.5 |                  6.0 / 26.6 |                179 |               185 |            410 | URL change         |
| staff · staff → players (back)                     |                   0 |             0 |                           — |                  — |                 — |              7 | URL change         |
| staff · players → calendar                         |                   1 |           4.0 |                  4.0 / 19.1 |                173 |               177 |            188 | URL change         |
| staff · calendar → next day                        |                   1 |           3.8 |                  3.8 / 18.9 |                182 |               186 |            194 | URL change         |
| staff · next day → today                           |                   1 |           3.7 |                  3.7 / 18.5 |                185 |               190 |            197 | URL change         |
| landing-player · /start → /me/bookings (full load) |                  19 |         369.7 |                 19.1 / 82.6 |                310 |               326 |            894 | first paint        |
| landing-staff · /start → club calendar (full load) |                  20 |         371.3 |                21.1 / 107.2 |                309 |               328 |            904 | first paint        |

### First Load JS per route

Next 16 with Turbopack no longer prints the size table: its `next build` route list
has no size column. The harness rebuilds the number from the build output, as the old
column was computed. It takes the union of `rootMainFiles` and each layout's and
page's `entryJSFiles`, and gzips each chunk. A cold load moved nearly the same bytes:
213 KB of script for `/` (208.5 here), and 263 KB for the diary (256.2).

| Route                      | First Load JS (gzip KB) | Raw KB | Chunks |
| -------------------------- | ----------------------: | -----: | -----: |
| `/`                        |                   208.5 |  690.8 |     11 |
| `/login`                   |                   221.9 |    728 |     11 |
| `/venues`                  |                   253.7 |  831.4 |     13 |
| `/me/bookings`             |                   257.2 |  842.2 |     13 |
| `/t/[slug]`                |                   209.1 |  691.7 |     12 |
| `/t/[slug]/admin/calendar` |                   256.2 |  839.1 |     14 |
| `/t/[slug]/admin/courts`   |                   256.0 |  838.8 |     14 |
| `/t/[slug]/admin/pricing`  |                   257.2 |  842.9 |     14 |
| `/t/[slug]/admin/players`  |                   255.6 |  837.3 |     14 |
| `/t/[slug]/admin/staff`    |                   254.7 |  834.5 |     14 |
| `/invite/[token]`          |                   217.7 |  708.2 |     11 |
| `/platform/moderation`     |                   218.1 |  711.6 |     11 |
| `/offline`                 |                   143.8 |  485.0 |      8 |
| `/design-system`           |                   283.4 |  931.0 |     14 |

### What the baseline says

- **Nothing on screen changes until the navigation is over.** There are no
  `loading.tsx` files, no `<Suspense>`, no `error.tsx` and no progress UI (verified
  by search, and by the harness: no loading UI appeared in any of the 1,280
  client-side navigations). The only "first feedback" is the URL. That changes in the
  same commit that renders the new page, 5–132 ms before it is painted on the phone.
  On the phone, a tap is followed by 190–540 ms of an unchanged screen.
- **Every client-side navigation pays at least one full round trip.** Every page is
  dynamic, and nothing useful is prefetched for dynamic routes that have no
  `loading.tsx`. Next 16 prefetches only each link's route tree: the entry diary
  sends 18 prefetches, and the next tap still fetches its RSC. The client cache keeps
  nothing, because `staleTimes.dynamic` defaults to 0. On the phone, warm
  navigations floor at 190–220 ms: the emulated 150 ms round trip, about 10 ms of
  server, and the render. The back button is the only instant navigation (26 ms)
  wherever the page is small.
- **A cold navigation pays two round trips.** The RSC payload names the
  destination's JS chunk, and only then is the chunk requested. That adds 170–285 ms
  on the phone: calendar → courts is 394 ms cold and 203 ms warm, and home → my
  bookings is 474 ms cold and 205 ms warm.
- **Full page loads take 0.72–0.90 s on the phone** (medians). The slowest sample
  here was 940 ms. In the two runs at `4efe8c1`, the post-sign-in landing crossed a
  second at p95 (1043 ms and 1011 ms): these rows ride on a third party's latency.
  First paint waits on a serial, render-blocking chain: the HTML, then the app's
  116 KB stylesheet, then the Google Fonts `@import` inside it, which cannot be
  discovered any earlier. Blocking the font requests brought the player landing's
  first paint from 900 ms to 648 ms (**#266**). About 260 KB of JS (gzip) also arrives
  in 13 chunks, queued on HTTP/1.1's six connections.
- **Server time is small here, and repeated.** On the desktop, the RSC's first byte
  arrives 4–10 ms after the click. Its last byte arrives 6–36 ms after for the
  public pages, and 37–55 ms after for `/me/bookings` and the club screens. That is
  the streaming render: session check, membership query, the page's transaction,
  and for courts and pricing one query per court, eight here. It happens again on
  every visit, and it is a lower bound; see _cannot tell you_ below.

### The three slowest journeys, and why

1. **landing-staff · `/start` → club diary (full load): 904 ms on the phone** (p95
   917 ms; 1011 ms in the runs at `4efe8c1`). Two document round trips come first:
   the 307 from `/start`, then the diary, whose first byte arrives at 309 ms. The
   diary's HTML is 107 KB decoded, because its RSC payload is inlined, and 57
   bookings and 8 courts render into it. Then 20 requests and 372 KB, including
   263 KB of JS. First paint waits on the app CSS, then the Google Fonts `@import`
   (#266).
2. **staff · load `/t/sofia-padel-club` (full load): 902 ms.** This is the same
   chain: `/t/[slug]` redirects to the diary with a 307.
3. **landing-player · `/start` → `/me/bookings` (full load): 894 ms** (p95 920 ms;
   1043 ms in the runs at `4efe8c1`). This is the same shape, with an 83 KB page.
   With the font requests blocked, first paint moves from 900 ms to 648 ms.

The slowest client-side navigations:

- **players → staff: 542 ms cold, 367 ms warm.** The staff screen lists every
  membership, players included, by design (`repositories/staff.ts`: promoting a
  regular is how a club gains staff). That is 126 rows and 26.6 KB of RSC. Warm, on
  the phone, the payload is in at 187 ms. It takes about 60 ms to process and commit,
  and 122 ms more to paint. The other pages paint 6–30 ms after their commit (the
  diary's grid takes the longest), and the 121-row players list about 55 ms after.
- **home → my bookings: 474 ms cold.** The RSC (23.5 KB) arrives at 198 ms. Only then
  is the page's 50 KB of JS requested.
- **home → venues (anonymous): 473 ms cold.** The pattern is the same, with 46 KB of
  JS. After it, `/venues` prefetches one 404 per venue card (#267).

### Run-to-run variance

The two runs, compared row by row as |median of run A − median of run B|:

| Rows                           | median | p90    | max           |
| ------------------------------ | ------ | ------ | ------------- |
| phone, client-side (32 rows)   | 1.1 ms | 4.3 ms | 7.3 ms (3.7%) |
| phone, full loads (7 rows)     | 16 ms  | 23 ms  | 28 ms (3.8%)  |
| desktop, client-side (32 rows) | 1.8 ms | 6.5 ms | 8.3 ms (44%)  |
| desktop, full loads (7 rows)   | 18 ms  | 27 ms  | 32 ms (12.5%) |

Throttled phone navigations repeat to within a few milliseconds. The full loads vary
most, because they wait on `fonts.googleapis.com` across the real internet. The
pair of runs at `4efe8c1` saw 74 ms between runs on one of these rows, and a landing
p95 over a second. Desktop numbers are small, so a few milliseconds of scheduling
noise is a large fraction of them.

**What is a real difference.** `perf:compare` calls a change real only if it exceeds
the largest of three: twice this baseline's own spread for that row, 10% of the
before median, and 20 ms. In practice, on the phone a soft navigation that moves by
more than 20 ms has changed. A full load needs to move by more than about 100 ms
before it means anything. Desktop soft navigations are best read in requests and
bytes, which do not vary at all.

## Method

### Journeys

Each journey is a loop of real clicks (taps, on the phone) that ends where it began.
The entry page is the only `goto`.

| Journey | Account                             | Entry                                   | Steps                                                                                                                                                                  |
| ------- | ----------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public  | anonymous                           | `/`                                     | → venues (the call to action), → home (the wordmark), → login (header), back                                                                                           |
| player  | `player@perf.playerz.test`          | `/`                                     | → my bookings (header), → home, → venues, → home                                                                                                                       |
| staff   | `owner@sofia.bg`, OWNER of one club | `/t/sofia-padel-club` (307 → the diary) | the club nav: → courts → pricing → players → staff; the back button; → calendar (nav); the diary's "next day" link; its "today" link                                   |
| landing | player, then staff                  | `/start`                                | the post-sign-in redirect chain as a full load: what Google or Microsoft's callback lands on (#227). There is no web sign-in form to click, so this is the one `goto`. |

Left out on purpose:

- **Links that 404.** These are the venue cards (#267) and the club nav's
  open-play, coaches and my-bookings (#260). A 404 is not a navigation to time.
- **The role switcher.** #263 made accounts one kind each (player, club at one
  club, or coach) and removed the switcher, so no account here holds both a player
  and a club role. The fixture creates each account with its kind, as the database
  now requires.
- **Writes** (a review, a no-show, a price change). They mutate the data every later
  run depends on. Their `revalidatePath` / `router.refresh` cost belongs in its own
  harness.

### When a navigation starts, and when it is done

All timestamps are taken in the page with `performance.now()`, by the agent that
`tests/perf/agent.ts` injects before any app script runs.

- **t0** is the click's own `event.timeStamp`, read by a capturing listener on
  `window`, before Next's `<Link>` handler. For the back button, it is the moment
  `history.back()` is called.
- **t_url** is the Navigation API's `currententrychange`, when the router pushes the
  new URL.
- **t_loading_ui** is the first NEW visible element matching `FEEDBACK_SELECTOR`
  (`[role=progressbar]`; `[aria-busy=true]` on anything but a button; `shimmer`,
  `animate-pulse` and `animate-spin` classes; `.loading-spinner`,
  `[data-skeleton-table]`, `[data-loading]` and `[data-perf-feedback]`). Those are
  the design system's skeleton and spinner primitives. **A `loading.tsx` built from
  something else must add `data-loading` to be counted.** `aria-busy` on a button
  is excluded because it is invisible.
- **t_feedback** is the earlier of t_url and t_loading_ui. For a full load it is the
  first contentful paint.
- **t_ready** is the moment the destination's ready conditions (below) all hold,
  timestamped after the next paint: a task posted from `requestAnimationFrame` runs
  after that frame is rendered. For a full load, it is the later of that and first
  contentful paint, because content can be in the DOM while a stylesheet holds the
  paint back.

The ready conditions, in `nav-latency.spec.ts` `READY`, are one per destination.
Each is the page's heading, taken from `messages/bg.json` as the e2e specs do, plus
the content that heading introduces.

| Destination    | Ready when                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `/`            | `main h1` "playerz.bg" and the venues call to action                                            |
| `/venues`      | `main h1` "Играй" and a venue card link                                                         |
| `/login`       | `main h1` "Вход"                                                                                |
| `/me/bookings` | `main h1` "Моите резервации" and a booking (`main li`)                                          |
| diary, any day | `main h1` "Календар", that day's own "next day" link (unique per day), and the grid ("Court 1") |
| courts         | `main h1` "Кортове" and a court card's `h2`                                                     |
| pricing        | `main h1` "Ценообразуване" and a rule (`main li` "Weekend peak")                                |
| players, staff | `main h1` "Играчи" / "Персонал" and a row (`main li`)                                           |

If a page changes so that its condition never holds, the step fails after 45 s with
the condition that failed. It does not report a fast wrong number.

### Network

The harness records every request from CDP's `Network` events, on the page's own
target. For each navigation:

- **Requests and KB waited for** are those started between t0 and the commit. Links
  on the new page start prefetching as that commit mounts them; those are counted as
  **trailing**, not waited for.
- **Prefetches before** are the Next.js prefetch requests the origin page made
  between arriving and the click.
- **Payload** is the navigation's RSC response, or the final HTML of a full load.
  Wire bytes are what CDP reports on completion. The router cancels an RSC fetch
  once it has read it, CDP then never reports completion, and for those the
  renderer's Resource Timing `transferSize` is used.

"Network idle" is **no request waiting for headers, and nothing moving for
500 ms**. A plain "nothing in flight" never arrives here: Chrome never reports the
dead links' 404 prefetches as finished (#267), and waiting for them cost 20 s per
click.

### Profiles

| Profile | Device                                                    | CPU                                     | Network                                                                                              | Input                                                 |
| ------- | --------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| phone   | Playwright's `Pixel 5` (393×727, DPR 2.75, touch, mobile) | `Emulation.setCPUThrottlingRate` **×4** | `Network.emulateNetworkConditions`: **150 ms** latency, **9 Mbps** down, **1.5 Mbps** up, cellular4g | a tap: touchstart, touchend, then the browser's click |
| desktop | `Desktop Chrome` (1280×720)                               | unthrottled                             | none                                                                                                 | a click                                               |

The phone uses DevTools' "Fast 4G" throughput with "Slow 4G" latency. **Localhost has
no network latency.** Without emulation a round trip costs 0 ms, and a waterfall of
dependent requests looks free, which is exactly what a phone pays for. So the phone
columns mean more than the desktop ones. Chrome applies the 150 ms per request, before
the response headers. It does not model TCP, DNS or TLS handshakes.

CPU ×4 on this Apple M2 Pro approximates an upper-mid-range Android. Lighthouse
calibrates ×4 against far slower desktops, so a budget phone is slower than this.

The phone's taps are aimed at the link's measured centre and hit-tested first. On a
393 px screen the club nav is 934 px wide (#255). The layout viewport widens to match,
and Playwright's own `tap()` hits the neighbouring link.

### Cold and warm

- **Cold** is the first time round a loop in a fresh browser context: empty HTTP
  cache, empty router cache, no JS loaded. Sessions come from `global-setup.ts`, which
  signs each account in once, through the real credentials provider, as the e2e
  `authedPage` fixture does. Fresh contexts reuse that session, so "cold" is not
  "signed out".
- **Warm** is the second time round, in the same page: JS loaded, HTTP cache full,
  and whatever the router kept. What the router keeps is exactly what `staleTimes`
  and prefetching will change. For the landing, warm is a second `goto /start` in the
  same context.

Runs are interleaved: every journey's first context, then every journey's second,
and so on. Drift in the machine's load therefore spreads across journeys.

### What is settled before each click

Before each click the harness waits for network idle (above), then for an idle main
thread (`requestIdleCallback`). It also checks that the link is hydrated, because a
click before hydration is a full page load. The link is scrolled into view first, as
a thumb would. A real person does not wait for the network to go quiet. Clicking
into an unfinished prefetch costs something real, but it would make every sample a
different race. **These numbers are for the settled case.**

### Data

`tests/perf/seed-perf.ts` fills in the rest of `scripts/seed.ts`, deterministically
and relative to the club's today:

- Sofia Padel Club: 8 courts over two sites, 3 pricing rules each, 121 players, an
  owner, a manager, two front-desk staff, a coach and two open invites.
- 45 days of history and 14 days ahead, at about half occupancy. That is 6,233
  bookings, 57 of them in today's diary.
- Plovdiv: 6 courts and 61 players.
- 8 more clubs, so `/venues` lists 11 venues.
- The player has 24 bookings at both clubs: played, upcoming and cancelled. One venue
  is reviewed, so the first page of `/me/bookings` is full.

Each court-day draws from its own fixed-seed PRNG, so today's diary is the same
whatever the date. **Which of today's bookings have already started does depend on
the time of day.** That decides their status, and whether the diary offers a no-show
control on them. This baseline was taken at 22:41 and 22:52 Sofia time.
`perf:compare` warns when two runs started three or more hours apart.

### The server

`tests/perf/serve.ts` does the following, in order, on every run:

- truncates and re-seeds `playerz_perf`, refusing any database not named `*_perf` on
  this machine. `prisma migrate reset` is avoided because it refuses to run under an
  AI agent without a human's consent.
- runs `next build`, and never reuses a server, for the reason `playwright.config.ts`
  gives.
- serves with `next start -p 3301`.

The runtime connects as `playerz_perf_app`, with the same shape as P24's `playerz_app`.
Production refuses to boot on the owner's connection. `playerz_app` itself is not
used, because roles are cluster-wide and `least-privilege-in-use.test.ts` sets its
password back to NULL after every integration run. Before anything is timed, global
setup requests every page three times, as HTML and as RSC. The first request to a
route in a fresh `next start` loads its server chunk, and that cost belongs to the
process, not to the app.

## Running it

You need:

- the docker test stack (`docker compose -f docker-compose.test.yml up -d`: Postgres
  on 55432, Redis on 63790)
- an existing, empty-or-not `playerz_perf` database
- `npx playwright install chromium`
- port 3301 free. An interrupted run can leave `next-server` listening; find it with
  `lsof -iTCP:3301 -sTCP:LISTEN`.

```sh
npm run perf:nav
```

A run takes about 12 minutes on the machine above: roughly 1 min of seed and build,
6.5 min on the phone and 4.5 min on the desktop. It prints the three tables and
writes `.perf/runs/nav-<app sha>-<time>.json`, which is gitignored and holds every
sample in full.

| Variable            | Default                                                     | What it does                                                                         |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PERF_RUNS`         | 10                                                          | fresh contexts per journey per profile                                               |
| `PERF_WARM_PASSES`  | 1                                                           | extra times round each loop in the same page                                         |
| `PERF_DATABASE_URL` | `postgresql://playerz:playerz@127.0.0.1:55432/playerz_perf` | the OWNER URL; must be local and end in `_perf`                                      |
| `PERF_REDIS_URL`    | `redis://127.0.0.1:63790/5`                                 | the harness clears only the sign-in throttle's keys here                             |
| `PERF_PORT`         | 3301                                                        |                                                                                      |
| `PERF_SKIP_BUILD=1` | off                                                         | serve the existing `.next`. **For working on the harness only**; recorded in the run |
| `PERF_DEBUG=1`      | off                                                         | print each step's phases and every request it made                                   |

Keep the machine quiet while it runs. Other builds and test suites compete for the
same CPU. Every sample records the 1-minute load average, so an outlier can be
checked against it.

## Comparing a change

1. On your branch, run `npm run perf:nav` **twice**.
2. Merge the two runs:

   ```sh
   npm run perf:compare -- --merge .perf/runs/<a>.json .perf/runs/<b>.json --out .perf/after.json
   ```

3. Compare:

   ```sh
   npm run perf:compare -- docs/perf/baseline-a56ea4f.json .perf/after.json
   ```

   This prints every row's before and after medians, the difference, and a verdict:
   within noise, **faster** or **SLOWER** (see _What is a real difference_). Paste
   the table into the PR.

4. When a perf change merges, commit its merged runs as
   `docs/perf/baseline-<sha>.json` and update the tables here. The next change is
   then judged against it.

`npm run perf:compare -- --tables <file>` prints any run or baseline as the markdown
tables above. The tool prints "Feedback came from" as counts: `url 20/20`,
`fcp 20/20`, `loading-ui 20/20`. The labels above are those words spelled out. A
`loading.tsx` that works shows up in two places. That column turns to `loading-ui`,
and "First feedback" drops well below the time to ready.

## What the numbers can and cannot tell you

They **can** tell you:

- Whether a change made a navigation faster or slower, on this machine and this data,
  compared with the baseline's own noise.
- Where the time goes: the server (payload first byte on the desktop), the wire
  (round trips, payload bytes on the phone), or the client (payload's last byte to
  commit to paint).
- Whether anything appears before the page is done. Today, nothing does.
- Request counts, bytes, round trips and First Load JS. These do not depend on the
  machine at all.

They **cannot** tell you:

- **Absolute production latency.** The server ran on an M2 Pro. The production VM's
  vCPUs are slower, so server and render time there are longer. Postgres and
  PgBouncer share that VM (`docs/deploy-gcp.md`), so database round trips are
  sub-millisecond in both places: query waterfalls, like one query per court, are
  real here but barely visible in milliseconds. Count them instead.
- **A real mobile network.** The emulation is a fixed 150 ms per request, with no
  TLS or TCP handshakes, jitter, loss or slow start. Localhost is plain HTTP/1.1,
  with six connections per host. Production terminates HTTPS in Caddy, which speaks
  HTTP/2, so one connection carries every chunk there. Cold loads with many chunks
  are therefore pessimistic here, and the handshakes they skip are optimistic.
- **A real phone.** CPU ×4 approximates the processor, not the GPU, memory or
  thermal throttling.
- **Behaviour under load.** One user, one request at a time.
- **Intent.** The harness clicks as soon as the page is settled. A real desktop user
  hovers for a couple of hundred milliseconds first, and a hover-triggered prefetch
  gets that head start here only if it also fires on viewport entry.
- **Everything but navigation.** Not INP, not scroll, not writes.

Two more cautions:

- The full loads include a real request to Google's servers (#266). They depend on
  internet access, and they are the noisiest rows.
- Runs taken at different times of day see a different diary (see _Data_).

## Files

| File                              | What it is                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `playwright.perf.config.ts`       | its own config: two projects (`perf-phone`, `perf-desktop`), one worker, no retries |
| `tests/perf/nav-latency.spec.ts`  | the journeys and the ready conditions                                               |
| `tests/perf/agent.ts`             | the in-page clock                                                                   |
| `tests/perf/harness.ts`           | contexts, throttling, the CDP network recorder, taps, settling                      |
| `tests/perf/config.ts`            | ports, database, accounts, profiles: everything the others agree on                 |
| `tests/perf/serve.ts`             | the webServer: reset, seed, build, serve                                            |
| `tests/perf/prepare-db.ts`        | the database reset, its guard, and the runtime role                                 |
| `tests/perf/seed-perf.ts`         | the data                                                                            |
| `tests/perf/global-setup.ts`      | sign-in once per account; warm-up of every page                                     |
| `tests/perf/reporter.ts`          | collects samples, writes the run, prints the tables                                 |
| `tests/perf/report.ts`            | statistics, First Load JS, tables, the JSON format                                  |
| `tests/perf/compare.ts`           | `perf:compare`: merge runs into a baseline, compare two, print tables               |
| `docs/perf/baseline-a56ea4f.json` | this baseline: two runs, pooled, with run-to-run variance                           |
