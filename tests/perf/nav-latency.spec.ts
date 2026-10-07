import { test } from '@playwright/test';
import { formatInTimeZone } from 'date-fns-tz';

import bg from '../../messages/bg.json';

import type { FirstTable, ReadyTable } from './agent';
import {
  CLUB_SLUG,
  CLUB_TIMEZONE,
  PERF_PAUSE_MS,
  PERF_REMOTE,
  PERF_RUNS,
  PERF_WARM_PASSES,
  PROFILES,
  VENUE_NAME,
  VENUE_PUBLIC_SLUG,
  type PersonaId,
} from './config';
import { PerfSession, type WriteSpec } from './harness';

/**
 * Navigation latency, measured as a person on a phone experiences it.
 *
 * Each journey is a LOOP of real clicks (taps, on the phone) that ends where
 * it started. The entry page is the only `goto`. The first time round a loop,
 * in a fresh browser context, gives the COLD samples. Going round again in the
 * same page gives the WARM ones: JS already loaded, HTTP cache full, and
 * whatever the router kept. The router keeping more is exactly what
 * `staleTimes` and prefetching will change.
 *
 * The runs are interleaved (every journey's run 1, then every journey's run
 * 2, and so on), so drift in the machine's load spreads across all journeys
 * instead of landing on whichever ran last.
 *
 * `npm run perf:nav` runs this. It is NOT part of `npm run test:e2e` or CI:
 * it lives in its own config (playwright.perf.config.ts), because timings
 * taken on a shared CI runner are noise.
 */

const club = (page: string) => `/t/${CLUB_SLUG}/admin/${page}`;
const MAIN_NAV = `nav[aria-label="${bg.common.ui.mainNav}"]`;

/**
 * A tap on the club admin's nav, as the profile has it (T19).
 *
 * The admin shell renders the nav twice: in the desktop rail (an `<aside>`,
 * hidden below `md`) and, on a phone, in the left drawer once the hamburger
 * opens it. So a phone tap is two inputs: the hamburger, untimed (`before`),
 * then the link inside the drawer, timed as before. Each selector names the
 * one copy that is visible on its profile, so neither matches the other.
 *
 * The drawer's links prefetch (auto) as it opens, and the harness settles
 * before the timed tap, so those requests land in the step's "before"
 * prefetch count, which is when a person's thumb would have caused them.
 */
const NAV_DRAWER = '[data-testid="nav-drawer"]';
const NAV_TOGGLE = '[data-testid="nav-toggle"]';
function navTap(href: string, phone: boolean): { click: string; before?: string[] } {
  return phone
    ? { click: `${NAV_DRAWER} ${MAIN_NAV} a[href="${href}"]`, before: [NAV_TOGGLE] }
    : { click: `aside ${MAIN_NAV} a[href="${href}"]` };
}

/**
 * A tap on the player chrome (T20), as the profile has it. Below `md` the
 * header's links are hidden and the bottom tab bar carries them, so the phone
 * taps the tab and the desktop clicks the header; each selector names the one
 * copy visible on its profile. The step ids, and so their budget rows, are
 * unchanged: same page to same page, through the control that profile shows.
 */
const TAB_BAR = `nav[aria-label="${bg.common.nav.tabBar}"]`;
function playerTap(href: string, phone: boolean): { click: string } {
  return { click: phone ? `${TAB_BAR} a[href="${href}"]` : `header a[href="${href}"]` };
}

/** The club's today, the way the diary decides it (in the club's zone, not the server's). */
function shiftDay(isoDay: string, delta: number): string {
  const [y, m, d] = isoDay.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}
const today = formatInTimeZone(new Date(), CLUB_TIMEZONE, 'yyyy-MM-dd');
const tomorrow = shiftDay(today, 1);
const diaryDay = (isoDay: string) => `${club('calendar')}?day=${isoDay}`;

/**
 * The venue page (#355, #397). It mirrors the day on screen into the URL with
 * `replaceState` as it mounts (VenueBooking), so a tap on a card lands on
 * `/venues/{slug}?day={today}` and the day picker's "Утре" turns it into
 * `?day={tomorrow}`. Its days are the venue's, in its zone: the same Sofia
 * calendar as the diary's.
 */
const VENUE = `/venues/${VENUE_PUBLIC_SLUG}`;
const venueDay = (isoDay: string) => `${VENUE}?day=${isoDay}`;
const DAY_PICKER = `main [role="radiogroup"][aria-label="${bg.venue.day.label}"]`;

/**
 * One stable definition per destination of "its key content is visible". Each
 * uses the page's heading, taken from the catalogue (as the e2e specs do, so
 * rewording a heading is not a failure), plus the page's `[data-perf-ready]`
 * element — the one its page or board marks as its primary content — and,
 * where the seed puts known text in it, that text. On a client-side navigation
 * the previous page's content stays on screen until the new one commits, so
 * every condition here is unique to its destination.
 *
 * ═══ WHY A MARKER AND NOT `main li` ═══
 *
 * The table used to name each page's markup: `main li h2`, `main li a[href^=
 * "/venues/"]`. The perf programme is about to restyle every one of these
 * pages, and a page whose list became a table would have stopped matching,
 * so the step would time out and look like a regression. The marker states
 * what the page means ("my content is here") and survives a restyle. It
 * changes how the content is FOUND, not when it counts as ready: each marker
 * sits on the element the old selector found, or on its parent list.
 *
 * A loading skeleton never carries `main h1` or `[data-perf-ready]`
 * (src/components/loading/route-skeleton.tsx), so it cannot be mistaken for
 * the content.
 *
 * The diary is identified by its own "next day" link, which differs for every
 * day and does not depend on how the date label is formatted. Its h1 and grid
 * are the same on every day, so the link is what tells today from tomorrow.
 */
const READY: ReadyTable = {
  '/': [
    { selector: 'main h1', text: bg.landing.hero.title },
    { selector: 'main [data-perf-ready]' },
  ],
  '/venues': [
    { selector: 'main h1', text: bg.venues.title },
    { selector: 'main [data-perf-ready]' },
  ],
  '/login': [{ selector: 'main h1', text: bg.login.title }],
  '/me/bookings': [
    { selector: 'main h1', text: bg.myBookings.title },
    { selector: 'main [data-perf-ready]' },
  ],
  // The venue page, on each day the journeys show. The name is the venue's
  // own h1; the day picker's checked option tells today from tomorrow, as the
  // diary's "next day" link does; `[data-perf-ready]` is the court list,
  // which VenueBooking renders only once that day's slots are in (the day
  // switch shows a skeleton while it fetches: `keepPreviousData` is off).
  // Tomorrow must also show a bookable time, a slot button inside a court's
  // time group: the seed leaves it about half free. Today is not asked for
  // one, because late in the evening every one of today's slots has started.
  [venueDay(today)]: [
    { selector: 'main h1', text: VENUE_NAME },
    { selector: `${DAY_PICKER} [role="radio"][aria-checked="true"]`, text: bg.venue.day.today },
    { selector: 'main [data-perf-ready]', text: 'Court 1' },
  ],
  [venueDay(tomorrow)]: [
    { selector: 'main h1', text: VENUE_NAME },
    {
      selector: `${DAY_PICKER} [role="radio"][aria-checked="true"]`,
      text: bg.venue.day.tomorrow,
    },
    { selector: 'main [data-perf-ready]', text: 'Court 1' },
    { selector: 'main [data-perf-ready] [role="group"] button' },
  ],
  [club('calendar')]: [
    { selector: 'main h1', text: bg.admin.calendar.title },
    { selector: `main a[href="${diaryDay(tomorrow)}"]` },
    { selector: 'main [data-perf-ready]', text: 'Court 1' },
  ],
  [diaryDay(tomorrow)]: [
    { selector: 'main h1', text: bg.admin.calendar.title },
    { selector: `main a[href="${diaryDay(shiftDay(tomorrow, 1))}"]` },
    { selector: 'main [data-perf-ready]', text: 'Court 1' },
  ],
  [club('courts')]: [
    { selector: 'main h1', text: bg.admin.courts.title },
    { selector: 'main [data-perf-ready]', text: 'Court 1' },
  ],
  [club('pricing')]: [
    { selector: 'main h1', text: bg.admin.pricing.title },
    { selector: 'main [data-perf-ready]', text: 'Weekend peak' },
  ],
  [club('players')]: [
    { selector: 'main h1', text: bg.admin.players.title },
    { selector: 'main [data-perf-ready]' },
  ],
  [club('staff')]: [
    { selector: 'main h1', text: bg.admin.staff.title },
    { selector: 'main [data-perf-ready]' },
  ],
};

/**
 * FIRST CONTENT (#403): for a page that paints in two stages, what the first
 * stage is. Timed as `tFirst`, alongside `tReady`, which still waits for the
 * whole of READY above. Keyed by pathname: the venue page writes `?day=` into
 * the URL only as its booking panel mounts, after the header has painted.
 *
 * The venue page's header (its h1, the venue's name) needs one row read, and
 * paints before the day's slots, which wait behind their own Suspense boundary.
 */
const FIRST: FirstTable = {
  [VENUE]: [{ selector: 'main h1', text: VENUE_NAME }],
};

/**
 * One input. `click` is a selector; `nav` is an href in the admin nav, which
 * `navTap` turns into the right selector (and the drawer opening, on a phone)
 * for the profile being measured; `tab` is an href in the player chrome,
 * which `playerTap` turns into the tab bar's link or the header's.
 */
type Step =
  | ({ id: string; to: string } & (
      { click: string; before?: string[] } | { back: true } | { nav: string } | { tab: string }
    ))
  | { id: string; write: WriteSpec };

/**
 * The courts screen's edit form, by its `data-perf-write` markers
 * (CourtForm.tsx). The first court is renamed, and then renamed back, so the
 * data every later step reads is the data it started with.
 */
const COURT_SUFFIX = ' (perf)';
const courtWrite = (value: (current: string) => string): WriteSpec => ({
  // The first court card's first button is its Edit button; the text check
  // makes a reordered card fail loudly instead of archiving a court.
  open: {
    selector: 'main ul[data-perf-ready] > li:first-child button',
    text: bg.admin.courts.action.edit,
  },
  form: '[data-perf-write="form"]',
  field: '[data-perf-write="name"]',
  value,
  submit: '[data-perf-write="submit"]',
  shown: 'main ul[data-perf-ready] > li:first-child h2',
});

interface Journey {
  id: string;
  persona: PersonaId | null;
  /** The only goto. */
  entry: string;
  /** Where the entry lands after redirects. */
  lands: string;
  steps: Step[];
  /**
   * Needs the perf seed (a known venue's public slug), so it is never run
   * against a server the harness did not seed (PERF_BASE_URL).
   */
  seeded?: true;
}

/**
 * /venues → a venue's page → its next day → back to /venues (#397), the way a
 * player finds a court. The step that matters is the first: the cards keep
 * the default (auto) prefetch (navigation-policy.md), so a tap paints the
 * page's `loading.tsx` skeleton at once and the page arrives with the tap's
 * own round trip. "next day" is not a router navigation: it is the day
 * picker, which reads the day through SWR (`GET /api/v1/venues/{id}/
 * availability?date=`) and mirrors it into the URL with `replaceState`, so it
 * is timed from the tap to that day's slots on the glass. The way back is the
 * page's own back link to the index.
 *
 * A journey of its own, entered at /venues, rather than steps inserted into
 * the public and player loops: the existing loops' rows are judged against
 * budgets whose warm rows are router-cache hits inside a 30 s window
 * (`staleTimes.dynamic`), and three more steps in the same loop would move
 * them by lengthening it. The entry is a full load of /venues, as a shared or
 * searched link to it is.
 */
function venueSteps(): Step[] {
  return [
    {
      id: 'venues → venue',
      to: venueDay(today),
      click: `main a[href="${VENUE}"]`,
    },
    {
      id: 'venue → next day',
      to: venueDay(tomorrow),
      // The picker's second option is tomorrow (VenueBooking's dayOptions).
      click: `${DAY_PICKER} [role="radio"]:nth-child(2)`,
    },
    { id: 'venue → venues', to: '/venues', click: 'main a[href="/venues"]' },
  ];
}

/**
 * Only links to pages that exist are timed: a 404 is not a navigation. The
 * club nav's `open-play`, `coaches` and `my-bookings` were dead (#260) until
 * T19 removed them. The venue cards were plain text from #267 until the venue
 * page existed (#355); `venues → venue` is timed by the venue journeys below
 * (#397), anonymous and signed in.
 *
 * The staff steps keep their ids across T19, so their budget rows still
 * apply: on a phone each nav step now opens the drawer first, untimed.
 */
const JOURNEYS: Journey[] = [
  {
    id: 'public',
    persona: null,
    entry: '/',
    lands: '/',
    steps: [
      { id: 'home → venues', to: '/venues', click: 'main a[href="/venues"]' },
      { id: 'venues → home', to: '/', click: 'header a[href="/"]' },
      { id: 'home → login', to: '/login', tab: '/login' },
      { id: 'login → home (back)', to: '/', back: true },
    ],
  },
  {
    id: 'player',
    persona: 'player',
    entry: '/',
    lands: '/',
    steps: [
      { id: 'home → my bookings', to: '/me/bookings', tab: '/me/bookings' },
      { id: 'my bookings → home', to: '/', click: 'header a[href="/"]' },
      { id: 'home → venues', to: '/venues', click: 'main a[href="/venues"]' },
      { id: 'venues → home', to: '/', click: 'header a[href="/"]' },
    ],
  },
  {
    id: 'public-venue',
    persona: null,
    entry: '/venues',
    lands: '/venues',
    steps: venueSteps(),
    seeded: true,
  },
  {
    // Signed in, the page also renders the player chrome and wraps the slots
    // in the viewer's scope; the steps are the same.
    id: 'player-venue',
    persona: 'player',
    entry: '/venues',
    lands: '/venues',
    steps: venueSteps(),
    seeded: true,
  },
  {
    // /t/{slug} redirects a club role to the diary; then every admin screen,
    // the back button, and a day forward and back in the diary.
    id: 'staff',
    persona: 'staff',
    entry: `/t/${CLUB_SLUG}`,
    lands: club('calendar'),
    steps: [
      {
        id: 'calendar → courts',
        to: club('courts'),
        nav: club('courts'),
      },
      {
        id: 'courts → pricing',
        to: club('pricing'),
        nav: club('pricing'),
      },
      {
        id: 'pricing → players',
        to: club('players'),
        nav: club('players'),
      },
      { id: 'players → staff', to: club('staff'), nav: club('staff') },
      { id: 'staff → players (back)', to: club('players'), back: true },
      {
        id: 'players → calendar',
        to: club('calendar'),
        nav: club('calendar'),
      },
      {
        id: 'calendar → next day',
        to: diaryDay(tomorrow),
        click: `main a[href="${diaryDay(tomorrow)}"]`,
      },
      { id: 'next day → today', to: club('calendar'), click: `main a[href="${club('calendar')}"]` },
    ],
  },
  {
    // What a write costs (T30). A revalidating Server Action purges the whole
    // client router cache and re-prefetches the visible links, so the write
    // step counts its requests, and the navigation after it shows what the
    // purge costs the next tap. The loop ends where it began.
    id: 'staff-write',
    persona: 'staff',
    entry: `/t/${CLUB_SLUG}`,
    lands: club('calendar'),
    steps: [
      {
        id: 'calendar → courts',
        to: club('courts'),
        nav: club('courts'),
      },
      { id: 'rename a court', write: courtWrite((name) => `${name}${COURT_SUFFIX}`) },
      {
        id: 'rename it back',
        write: courtWrite((name) => {
          if (!name.endsWith(COURT_SUFFIX)) throw new Error(`"${name}" was not renamed`);
          return name.slice(0, -COURT_SUFFIX.length);
        }),
      },
      {
        id: 'courts → pricing (after the writes)',
        to: club('pricing'),
        nav: club('pricing'),
      },
      {
        id: 'pricing → calendar',
        to: club('calendar'),
        nav: club('calendar'),
      },
    ],
  },
];

/**
 * After Google or Microsoft hands back, next-auth redirects to `/start`, which
 * redirects again by role (#227). That is a full page load through two hops,
 * and it is the first thing every signed-in session waits for. COLD is a
 * fresh context; WARM is the same context landing a second time, with its
 * HTTP cache full.
 */
const LANDINGS: Array<{ id: string; persona: PersonaId; lands: string }> = [
  { id: 'landing-player', persona: 'player', lands: '/me/bookings' },
  { id: 'landing-staff', persona: 'staff', lands: club('calendar') },
];

/**
 * Against a server the harness did not start (PERF_BASE_URL, e.g. production),
 * only the anonymous, read-only journeys exist. The signed-in ones need the
 * perf seed's accounts, and staff-write renames a court: neither belongs on a
 * live server, so they are never registered there. Nor is `public-venue`,
 * which opens the perf seed's venue by its slug.
 */
const journeys = PERF_REMOTE ? JOURNEYS.filter((j) => j.persona === null && !j.seeded) : JOURNEYS;
const landings = PERF_REMOTE ? [] : LANDINGS;

if (PERF_PAUSE_MS > 0) {
  test.afterEach(async () => {
    await new Promise((r) => setTimeout(r, PERF_PAUSE_MS));
  });
}

for (let run = 1; run <= PERF_RUNS; run++) {
  for (const j of journeys) {
    test(`${j.id} · run ${run}`, async ({ browser }, testInfo) => {
      const profile = PROFILES[testInfo.project.metadata.profile as keyof typeof PROFILES];
      const s = await PerfSession.open({
        browser,
        profile,
        persona: j.persona,
        journey: j.id,
        run,
        table: READY,
        first: FIRST,
      });
      try {
        await s.enter({
          path: j.entry,
          key: j.lands,
          step: `load ${j.entry}`,
          mode: 'cold',
          pass: 0,
        });
        for (let pass = 0; pass <= PERF_WARM_PASSES; pass++) {
          for (const st of j.steps) {
            if ('write' in st) {
              await s.write({
                step: st.id,
                mode: pass === 0 ? 'cold' : 'warm',
                pass,
                spec: st.write,
              });
              continue;
            }
            const input =
              'nav' in st
                ? navTap(st.nav, profile.input === 'tap')
                : 'tab' in st
                  ? playerTap(st.tab, profile.input === 'tap')
                  : 'click' in st
                    ? { click: st.click, before: st.before }
                    : { back: true };
            await s.step({
              step: st.id,
              key: st.to,
              mode: pass === 0 ? 'cold' : 'warm',
              pass,
              ...input,
            });
          }
        }
      } finally {
        await testInfo.attach('perf-samples', {
          body: JSON.stringify({
            browser: s.browserVersion,
            samples: s.samples,
            warnings: s.warnings,
          }),
          contentType: 'application/json',
        });
        await s.close();
      }
    });
  }

  for (const l of landings) {
    test(`${l.id} · run ${run}`, async ({ browser }, testInfo) => {
      const profile = PROFILES[testInfo.project.metadata.profile as keyof typeof PROFILES];
      const s = await PerfSession.open({
        browser,
        profile,
        persona: l.persona,
        journey: l.id,
        run,
        table: READY,
      });
      try {
        for (let pass = 0; pass <= PERF_WARM_PASSES; pass++) {
          await s.enter({
            path: '/start',
            key: l.lands,
            step: `/start → ${l.lands.replace(`/t/${CLUB_SLUG}/admin/`, 'club ')}`,
            mode: pass === 0 ? 'cold' : 'warm',
            pass,
          });
        }
      } finally {
        await testInfo.attach('perf-samples', {
          body: JSON.stringify({
            browser: s.browserVersion,
            samples: s.samples,
            warnings: s.warnings,
          }),
          contentType: 'application/json',
        });
        await s.close();
      }
    });
  }
}
