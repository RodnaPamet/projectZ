# Usage counts and the pilot's numbers (#371)

How playerz counts its own use, and the two numbers the Sofia pilot is judged on (owner decisions
Q40 and Q48, 2026-10-04): each club's **online share of bookings**, and whether the club is **still
active** after two months.

## Privacy: our own counts, nothing else (Q48)

- No third-party tracker, no analytics cookie, no client-side tracking script. So no consent banner
  beyond the essentials (the legal pages are #370).
- Every count is a **daily aggregate** in `usage_daily` (P49): `(day, event, venueId, clubId, count)`.
  No user id, IP address, user agent, session or device is stored.
  `tests/guardrails/usage-no-personal-data.test.ts` pins the columns in the schema and every
  migration, and `tests/integration/usage-counts.test.ts` asks the live catalogue.
- The user agent is read when an event is counted, only to skip crawlers (`isBot` in
  `src/lib/usage/events.ts`, which also skips headless browsers and an absent user agent), and is
  then dropped.
- `usage_daily` denies `app_user` outright. Only `src/lib/usage/record.ts` writes it (BYPASSRLS,
  pinned in `superuser-call-sites`), and only the audited platform route reads it.

## The events, and where each is counted

| Event             | Funnel step | Counted in                                                                                         |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `VENUES_VIEW`     | 1           | `/venues` page (server component)                                                                  |
| `VENUE_VIEW`      | 2           | `/venues/{slug}` page (server component)                                                           |
| `SLOT_PICKED`     | 3           | the venue page's beacon, `POST /api/v1/venues/{id}/usage-events`                                   |
| `SHEET_OPENED`    | 4           | the beacon on "Резервирай"; or `VenueSlots` (server) when a sign-in returns with `?confirm=1`      |
| `BOOKING_CREATED` | 5           | `POST /api/v1/t/{slug}/bookings`, a new booking (not an idempotent replay)                         |
| `SLOTS_VIEW`      | not a step  | `GET /api/v1/venues/{id}/availability`: every day's times read, the page's refresh after paint too |

Each count is scheduled with Next's `after()`, so it runs once the response has gone: it adds no
time to a page and no round trip to a navigation, and any failure is a `usage count not recorded`
warning in the log, never an error the visitor sees. One `INSERT … ON CONFLICT DO UPDATE SET count =
count + 1` per event; no Redis buffer (at pilot traffic an indexed upsert after the response is
cheaper than batching, and a buffer would lose counts on every deploy). A router prefetch is not a
view. A venue event counts only for a publicly listed venue.

### The beacon

The two steps that happen only in the browser are sent by `sendUsageBeacon`
(`src/lib/data/usage-beacon.ts`) from the tap's handler: `fetch` with `credentials: 'omit'` and
`keepalive`, body `{"event": "SLOT_PICKED"}`, never awaited, every failure swallowed. Not even the
session cookie is sent. The route always answers 204, sets no cookie, and has its own rate-limit
bucket so slot taps never spend the booking POST's budget.

Its cost on the venue page, measured with two production builds of the same tree with and without
it: First Load JS 303.4 → 303.5 KB gzip (+0.1 KB). The helper is a dozen lines and `keys.ts` is
already in the page for the booking. No other public page gains client JS: every other event is
counted on the server. `/platform/usage` is a new route, budgeted at its measured 337.1 KB + 5%.
The card on "Отчети и такса" is a server component and ships no JS of its own: the page measures
340.7 KB with it, inside #372's 357.9 KB budget.

## The online share (Q40)

Defined once, in `countBookingsByChannel` (`src/app-layer/usecases/usage-report.ts`):

    online share = online / (online + desk)

- over a club's bookings that are `CONFIRMED` or `COMPLETED`, by `Booking.channel` (P40): `ONLINE`
  is a player in the app or on the web, `DESK` is the club entering one (#364), recurring series
  included;
- `CANCELLED`, `PENDING` (an unpaid hold) and `NO_SHOW` are not counted on either side;
- a booking falls in the month (or ISO week) it **starts** in, in Europe/Sofia. So a weekly desk
  series typed in one sitting counts once per week it is played, and the current month includes
  bookings already made for its remaining days;
- a period with no bookings has no share (shown as "—"), not 0%. The trend compares this month with
  last month; half a percentage point or less is "no change".

## The active club (Q40)

`isClubActive`, same file: a club is **active** when it has at least one booking (`CONFIRMED` or
`COMPLETED`, either channel) **made** (`createdAt`) in the last 14 days. By creation, not start, so
a long series typed in once does not keep a club that stopped using playerz looking alive.

## Where the numbers are shown

- **`/platform/usage`** (nav "Показатели"), for a platform grant carrying `TENANT_READ`. It reads
  `GET /api/v1/platform/usage?reason=…&days=7|30|90`, which writes a `PLATFORM_USAGE_READ` audit row
  with the stated reason before answering. A read, so no step-up. A table of clubs (online share this
  month and last, trend, bookings this month, the last 8 weeks, weeks since the club started, active
  or not) and the funnel for the whole site and per venue, with the conversion at each step.
- **"Онлайн резервации"** (`src/components/reports/online-share-card.tsx`) on the club admin's
  "Отчети и такса" page (#372), mounted by its `UsageCardSlot`: the online share of the month the page
  shows (this month by default) and of the five months before it, from `loadClubOnlineShare` under
  the club's tenant binding. If that read fails the statement still renders, without the card.

## Retention

`usage_daily` rows are kept. They are aggregates with nothing personal in them, and the pilot is
judged on months of them; `app_superuser` is not even granted `DELETE` on the table. A deleted venue
keeps its counters (shown as "Изтрит обект"). The online share and activity need no retention of
their own: they are read from `booking`.
