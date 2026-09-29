import { test } from '@playwright/test';
import { formatInTimeZone } from 'date-fns-tz';

import bg from '../../messages/bg.json';

import type { ReadyTable } from './agent';
import {
  CLUB_SLUG,
  CLUB_TIMEZONE,
  PERF_RUNS,
  PERF_WARM_PASSES,
  PROFILES,
  type PersonaId,
} from './config';
import { PerfSession } from './harness';

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

/** The club's today, the way the diary decides it (in the club's zone, not the server's). */
function shiftDay(isoDay: string, delta: number): string {
  const [y, m, d] = isoDay.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}
const today = formatInTimeZone(new Date(), CLUB_TIMEZONE, 'yyyy-MM-dd');
const tomorrow = shiftDay(today, 1);
const diaryDay = (isoDay: string) => `${club('calendar')}?day=${isoDay}`;

/**
 * One stable definition per destination of "its key content is visible". Each
 * uses the page's heading, taken from the catalogue (as the e2e specs do, so
 * rewording a heading is not a failure), plus the content that heading
 * introduces. On a client-side navigation the previous page's content stays
 * on screen until the new one commits, so every condition here is unique to
 * its destination.
 *
 * The diary is identified by its own "next day" link, which differs for every
 * day and does not depend on how the date label is formatted.
 */
const READY: ReadyTable = {
  '/': [{ selector: 'main h1', text: 'playerz.bg' }, { selector: 'main a[href="/venues"]' }],
  '/venues': [
    { selector: 'main h1', text: bg.venues.title },
    { selector: 'main li a[href^="/venues/"]' },
  ],
  '/login': [{ selector: 'main h1', text: bg.login.title }],
  '/me/bookings': [{ selector: 'main h1', text: bg.myBookings.title }, { selector: 'main li' }],
  [club('calendar')]: [
    { selector: 'main h1', text: bg.admin.calendar.title },
    { selector: `main a[href="${diaryDay(tomorrow)}"]` },
    { selector: 'main', text: 'Court 1' },
  ],
  [diaryDay(tomorrow)]: [
    { selector: 'main h1', text: bg.admin.calendar.title },
    { selector: `main a[href="${diaryDay(shiftDay(tomorrow, 1))}"]` },
    { selector: 'main', text: 'Court 1' },
  ],
  [club('courts')]: [
    { selector: 'main h1', text: bg.admin.courts.title },
    { selector: 'main li h2', text: 'Court 1' },
  ],
  [club('pricing')]: [
    { selector: 'main h1', text: bg.admin.pricing.title },
    { selector: 'main li', text: 'Weekend peak' },
  ],
  [club('players')]: [
    { selector: 'main h1', text: bg.admin.players.title },
    { selector: 'main li' },
  ],
  [club('staff')]: [{ selector: 'main h1', text: bg.admin.staff.title }, { selector: 'main li' }],
};

type Step = { id: string; to: string } & ({ click: string } | { back: true });

interface Journey {
  id: string;
  persona: PersonaId | null;
  /** The only goto. */
  entry: string;
  /** Where the entry lands after redirects. */
  lands: string;
  steps: Step[];
}

/**
 * Links that 404 today are left out on purpose. `/venues/{slug}` (every venue
 * card) and the club nav's `open-play`, `coaches` and `my-bookings` (#260)
 * point at pages that do not exist. A 404 is not a navigation to time.
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
      { id: 'home → login', to: '/login', click: 'header a[href="/login"]' },
      { id: 'login → home (back)', to: '/', back: true },
    ],
  },
  {
    id: 'player',
    persona: 'player',
    entry: '/',
    lands: '/',
    steps: [
      { id: 'home → my bookings', to: '/me/bookings', click: 'header a[href="/me/bookings"]' },
      { id: 'my bookings → home', to: '/', click: 'header a[href="/"]' },
      { id: 'home → venues', to: '/venues', click: 'main a[href="/venues"]' },
      { id: 'venues → home', to: '/', click: 'header a[href="/"]' },
    ],
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
        click: `${MAIN_NAV} a[href="${club('courts')}"]`,
      },
      {
        id: 'courts → pricing',
        to: club('pricing'),
        click: `${MAIN_NAV} a[href="${club('pricing')}"]`,
      },
      {
        id: 'pricing → players',
        to: club('players'),
        click: `${MAIN_NAV} a[href="${club('players')}"]`,
      },
      { id: 'players → staff', to: club('staff'), click: `${MAIN_NAV} a[href="${club('staff')}"]` },
      { id: 'staff → players (back)', to: club('players'), back: true },
      {
        id: 'players → calendar',
        to: club('calendar'),
        click: `${MAIN_NAV} a[href="${club('calendar')}"]`,
      },
      {
        id: 'calendar → next day',
        to: diaryDay(tomorrow),
        click: `main a[href="${diaryDay(tomorrow)}"]`,
      },
      { id: 'next day → today', to: club('calendar'), click: `main a[href="${club('calendar')}"]` },
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

for (let run = 1; run <= PERF_RUNS; run++) {
  for (const j of JOURNEYS) {
    test(`${j.id} · run ${run}`, async ({ browser }, testInfo) => {
      const profile = PROFILES[testInfo.project.metadata.profile as keyof typeof PROFILES];
      const s = await PerfSession.open({
        browser,
        profile,
        persona: j.persona,
        journey: j.id,
        run,
        table: READY,
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
            await s.step({
              step: st.id,
              key: st.to,
              mode: pass === 0 ? 'cold' : 'warm',
              pass,
              ...('click' in st ? { click: st.click } : { back: true }),
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

  for (const l of LANDINGS) {
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
