import { devices } from '@playwright/test';

/**
 * Everything the navigation-latency harness agrees on, in one place: where the
 * server runs, which database it may touch, who signs in, and what a "phone"
 * is. The Playwright config, the server script, the global setup, the spec and
 * the reporter all read it — two copies of a throttling profile is how a
 * before/after comparison ends up comparing two different phones.
 *
 * Every value can be overridden from the environment, and every override is
 * recorded in the run's JSON, so a number never travels without the conditions
 * it was measured under.
 */

/** Not 3000: `next dev` and the e2e webServer both want that port. */
export const PERF_PORT = Number(process.env.PERF_PORT ?? 3301);

/**
 * `PERF_BASE_URL` points the harness at a server it did not start, such as
 * production (`npm run perf:nav:prod`, playwright.perf.prod.config.ts). Unset,
 * the harness builds and serves the app itself on PERF_PORT.
 *
 * ═══ A REMOTE TARGET MEASURES THE REAL NETWORK ═══
 *
 * The phone's emulated 150 ms exists because localhost has no round trip.
 * Against a remote server the round trip is real (TLS, HTTP/2, the path from
 * this machine), and emulation would add 150 ms on top of it. So a remote run
 * keeps the phone's device, input and CPU ×4, and drops its network
 * emulation. The run's JSON records both, under `config.profiles`.
 */
export const PERF_REMOTE = Boolean(process.env.PERF_BASE_URL);
export const PERF_BASE_URL = (process.env.PERF_BASE_URL ?? `http://localhost:${PERF_PORT}`).replace(
  /\/+$/,
  '',
);

/**
 * Remote runs only: a pause after each browser context, so a run against a
 * live server stays a trickle of anonymous page views.
 */
export const PERF_PAUSE_MS = Number(process.env.PERF_PAUSE_MS ?? (PERF_REMOTE ? 3_000 : 0));

/**
 * The OWNER connection, used for migrations, the reset and the seed — the same
 * split CI's e2e job makes. The runtime connects as PERF_APP_ROLE instead.
 */
export const PERF_DB_OWNER_URL =
  process.env.PERF_DATABASE_URL ?? 'postgresql://playerz:playerz@127.0.0.1:55432/playerz_perf'; // pragma: allowlist secret

/**
 * The runtime role — P24's shape (LOGIN, NOINHERIT, `app_user` and
 * `app_superuser` granted WITH INHERIT FALSE), under a name nobody else uses.
 *
 * ═══ WHY NOT playerz_app ITSELF ═══
 *
 * Roles are CLUSTER-wide, and this Postgres is shared with every other test
 * database. `least-privilege-in-use.test.ts` sets `playerz_app`'s password
 * before its run and sets it back to NULL afterwards — so a perf server
 * authenticating as `playerz_app` loses the ability to open a new connection
 * the moment anybody's integration run finishes, and pg's pool opens new ones
 * every ten idle seconds. A role only this harness touches cannot be pulled out
 * from under it.
 *
 * ═══ WHY NOT THE OWNER ═══
 *
 * `next start` is production, and `assertLeastPrivilegeConnection` refuses to
 * boot a production server on a superuser connection. That refusal is the
 * point of P24; the harness measures the app as it is deployed, not around it.
 */
export const PERF_APP_ROLE = 'playerz_perf_app';
export const PERF_APP_ROLE_PASSWORD = 'perf-least-privilege'; // pragma: allowlist secret

export function appRoleUrl(ownerUrl: string = PERF_DB_OWNER_URL): string {
  const u = new URL(ownerUrl);
  u.username = PERF_APP_ROLE;
  u.password = PERF_APP_ROLE_PASSWORD;
  return u.toString();
}

/** Its own Redis database: the sign-in throttle and nothing else of ours lives here. */
export const PERF_REDIS_URL = process.env.PERF_REDIS_URL ?? 'redis://127.0.0.1:63790/5';

/**
 * Throwaway, and only ever used to sign a session for a local server. Not a
 * secret: anyone who can read this file can already read the database it
 * unlocks.
 */
export const PERF_NEXTAUTH_SECRET = 'perf-nextauth-secret-not-a-real-key'; // pragma: allowlist secret

/**
 * Production refuses to start a session without one: sign-in derives the
 * session hash from it (src/lib/security/encryption.ts). Throwaway, like the
 * secret above.
 */
export const PERF_DATA_ENCRYPTION_KEY = 'perf-data-encryption-key-throwaway-000000000000'; // pragma: allowlist secret

/**
 * The seeded club the staff journeys walk. `scripts/seed.ts` creates it; the
 * perf fixture fills it.
 */
export const CLUB_SLUG = 'sofia-padel-club';
export const CLUB_TIMEZONE = 'Europe/Sofia';

/** Dev credential from scripts/seed.ts, reused so the seeded owner can sign in. */
export const PERF_PASSWORD = 'Passw0rd!'; // pragma: allowlist secret

/**
 * One account per kind, never one account holding two (owner's decision: an
 * account is a player OR staff at one club OR a coach). The role switcher that
 * joined them was removed in #263, and the database now enforces the kinds,
 * so the fixture creates each account with its kind.
 */
export const PERSONAS = {
  /** Books at two clubs; lands on /me/bookings. */
  player: { email: 'player@perf.playerz.test', name: 'Георги Петров' },
  /** OWNER of CLUB_SLUG and nothing else; lands on the club's diary. */
  staff: { email: 'owner@sofia.bg', name: 'Ivan Petrov' },
} as const;
export type PersonaId = keyof typeof PERSONAS;

export const AUTH_DIR = '.perf/auth';
export const authStatePath = (p: PersonaId) => `${AUTH_DIR}/${p}.json`;

/** Where `serve.ts` leaves the build log and the reporter leaves each run. */
export const PERF_DIR = '.perf';
export const BUILD_LOG = `${PERF_DIR}/next-build.log`;
export const SERVER_LOG = `${PERF_DIR}/next-start.log`;
export const RUNS_DIR = `${PERF_DIR}/runs`;

/**
 * Fresh browser contexts per journey, per profile. Each gives one COLD sample
 * of every step and PERF_WARM_PASSES warm ones. Ten is the floor the baseline
 * was taken at; p95 of ten samples is nearly the maximum, and is reported as
 * such rather than dressed up.
 */
export const PERF_RUNS = Number(process.env.PERF_RUNS ?? 10);
export const PERF_WARM_PASSES = Number(process.env.PERF_WARM_PASSES ?? 1);

export interface NetworkProfile {
  offline: false;
  /** Added to every request before its response headers arrive, in ms. */
  latency: number;
  /** Bytes per second. */
  downloadThroughput: number;
  uploadThroughput: number;
  connectionType: 'cellular4g';
}

export interface PerfProfile {
  id: 'phone' | 'desktop';
  device: (typeof devices)[string];
  /** CDP `Emulation.setCPUThrottlingRate`; 1 means none. */
  cpuThrottlingRate: number;
  /** CDP `Network.emulateNetworkConditions`; null means none. */
  network: NetworkProfile | null;
  /** Phones are tapped, desktops clicked. Next's Link prefetches on touchstart. */
  input: 'tap' | 'click';
}

const MBPS = 1_000_000 / 8;

export const PROFILES: Record<PerfProfile['id'], PerfProfile> = {
  /**
   * The people this app is for are standing at a court with a phone.
   *
   * Pixel 5 because the e2e `mobile` project already uses it. CPU ×4 on an
   * Apple M2 Pro is roughly an upper-mid-range Android, NOT a budget one —
   * Lighthouse calibrates ×4 against a much slower desktop than this.
   *
   * 9 Mbps down, 1.5 Mbps up, 150 ms: DevTools' "Fast 4G" throughput with
   * "Slow 4G" latency. Chrome applies `latency` per REQUEST, before the
   * response headers — it does not model TCP or TLS handshakes, and localhost
   * is HTTP/1.1 with six connections per host where production is HTTP/2.
   * Without it a localhost round trip is ~0 ms and a waterfall of five
   * sequential requests costs nothing, which is exactly the thing a phone
   * pays for.
   */
  phone: {
    id: 'phone',
    device: devices['Pixel 5'],
    cpuThrottlingRate: 4,
    network: PERF_REMOTE
      ? null
      : {
          offline: false,
          latency: 150,
          downloadThroughput: 9 * MBPS,
          uploadThroughput: 1.5 * MBPS,
          connectionType: 'cellular4g',
        },
    input: 'tap',
  },
  /** Unthrottled: the floor. What a front desk on the club's own network sees. */
  desktop: {
    id: 'desktop',
    device: devices['Desktop Chrome'],
    cpuThrottlingRate: 1,
    network: null,
    input: 'click',
  },
};

/** Per-step ceilings. A step that blows through one is a failure, not a slow sample. */
export const STEP_TIMEOUT_MS = 45_000;

/**
 * What counts as "the network has gone quiet" before a click, and after one.
 * The click happens on a page that has finished loading and prefetching, so
 * two runs start from the same state; see README "What is settled".
 */
export const QUIET_MS = 500;

/**
 * How long after a write commits its requests are still counted as the
 * write's (harness.ts `write`): the refreshed page and the viewport's
 * re-prefetches after the router cache is purged.
 */
export const WRITE_WINDOW_MS = 3_000;
export const SETTLE_TIMEOUT_MS = 20_000;
