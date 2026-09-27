import { globSync, readFileSync } from 'node:fs';

import { signInMethods } from '@/lib/auth/sign-in-methods';

/**
 * "THAT BUTTON IS NOT OFFERED" MUST BE VISIBLE, NOT JUST TRUE.
 *
 * The OAuth providers were registered unconditionally with `?? ''` for missing
 * credentials, while `src/env.ts` declared the same variables REQUIRED. The two
 * disagreed, and both halves were wrong in their own direction:
 *
 *   - env validation refused to boot the app at all without two OAuth app
 *     registrations, including for tests and the seed, neither of which signs
 *     in through a provider;
 *   - the code underneath tolerated their absence and rendered a button that
 *     failed at Google rather than here.
 */
const OAUTH = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
] as const;

describe('signInMethods', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of OAUTH) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('reports both OAuth providers disabled when nothing is configured', () => {
    expect(signInMethods()).toEqual({
      google: 'disabled',
      microsoft: 'disabled',
      credentials: 'configured',
    });
  });

  it.each([
    ['google', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    ['microsoft', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  ])('%s needs BOTH halves of the pair', (method, idVar, secretVar) => {
    // Half a pair is the broken-button case: enough to register a provider,
    // not enough for it to work, and the failure happens at the provider.
    process.env[idVar] = 'an-id';
    expect(signInMethods()[method as 'google' | 'microsoft']).toBe('disabled');

    process.env[secretVar] = 'a-secret'; // pragma: allowlist secret
    expect(signInMethods()[method as 'google' | 'microsoft']).toBe('configured');
  });

  it('reports the two providers independently', () => {
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret'; // pragma: allowlist secret

    expect(signInMethods()).toEqual({
      google: 'configured',
      microsoft: 'disabled',
      credentials: 'configured',
    });
  });

  it('treats an empty string as absent', () => {
    // `GOOGLE_CLIENT_ID=` in a .env sets an empty string. auth.ts checks
    // truthiness, so it would skip the provider while this claimed otherwise.
    process.env.GOOGLE_CLIENT_ID = '';
    process.env.GOOGLE_CLIENT_SECRET = '';
    expect(signInMethods().google).toBe('disabled');
  });
});

describe('the dead auth variables stay dead', () => {
  it('env.ts does not require variables that nothing reads', () => {
    // AUTH_URL and AUTH_SECRET are the Auth.js **v5** names; this app is on
    // next-auth **v4** and reads NEXTAUTH_URL / NEXTAUTH_SECRET. They arrived
    // with the port from inflect-compliance, where they are correct, and here
    // they were REQUIRED and read by nothing — so `npm run dev` failed on every
    // route importing env.ts, with an error naming variables that do not
    // appear anywhere else in the codebase.
    //
    // JWT_SECRET and UPLOAD_DIR were the same: required, never read.
    const env = readFileSync('src/env.ts', 'utf8');

    for (const dead of ['AUTH_SECRET', 'JWT_SECRET', 'UPLOAD_DIR']) {
      // Declarations only — the explanatory comment names them on purpose.
      expect(env).not.toMatch(new RegExp(`^\\s+${dead}: z\\.`, 'm'));
      expect(env).not.toMatch(new RegExp(`^\\s+${dead}: process\\.env\\.`, 'm'));
    }
    // AUTH_URL needs a boundary so it does not match NEXTAUTH_URL.
    expect(env).not.toMatch(/^\s+AUTH_URL: z\./m);
    expect(env).not.toMatch(/^\s+AUTH_URL: process\.env\./m);
  });

  it('the v4 names it DOES read are still declared', () => {
    const env = readFileSync('src/env.ts', 'utf8');
    expect(env).toMatch(/^\s+NEXTAUTH_URL: z\./m);
    expect(env).toMatch(/NEXTAUTH_SECRET/);
  });
});

describe('the secrets production cannot boot without', () => {
  // ═══ WHY THIS IS HERE AND NOT ONLY IN env.ts ═══
  //
  // `NEXTAUTH_SECRET` was read in six places — middleware, the v1 context, the
  // native token route, logout, page-context — and declared in `src/env.ts`
  // nowhere. Without it next-auth cannot sign or verify a JWT, so the app
  // boots, serves public pages, and rejects EVERY authenticated request.
  //
  // That is the worst shape a deploy failure can take, because "it started
  // successfully" is true. #214 removed four variables that were required and
  // read by nothing; this is the same bug pointing the other way.
  it.each(['NEXTAUTH_SECRET', 'DATA_ENCRYPTION_KEY', 'REDIS_URL'])(
    '%s is declared AND refuses to be absent in production',
    (name) => {
      const env = readFileSync('src/env.ts', 'utf8');

      expect(env).toMatch(new RegExp(`^\\s+${name}: z`, 'm'));
      expect(env).toMatch(new RegExp(`^\\s+${name}: process\\.env\\.${name},`, 'm'));
      // Each guards production explicitly rather than trusting a caller to
      // notice it is undefined.
      expect(env).toMatch(new RegExp(`${name} is REQUIRED in production`));
    },
  );

  /**
   * Variables read from `process.env` in src/ that `env.ts` does not declare.
   *
   * ═══ WHY THIS IS A RATCHET AND NOT AN EMPTY ARRAY ═══
   *
   * There are sixteen of them, found while preparing the first deploy. Reading
   * at use is the house style — `send.ts` does it for VAPID, `apns.ts` for its
   * keys — and being DECLARED is what puts a variable on the documented
   * surface. These are undocumented: nothing validates them, nothing lists
   * them, and a deploy missing one fails at the moment the feature is used
   * rather than at boot.
   *
   * Fixing all sixteen is not this change. Several are production-relevant and
   * deserve the same treatment NEXTAUTH_SECRET just got — CRON_SECRET gates the
   * scheduled jobs, and the four CENTRIFUGO_* values are the realtime
   * transport — but each needs a decision about whether absence should refuse
   * to boot or disable a feature, and that is not a decision to take in bulk.
   *
   * So the list is frozen. Nothing new joins it, and removing an entry by
   * declaring it properly is the intended direction of travel.
   */
  const UNDECLARED_RATCHET = [
    'CENTRIFUGO_API_KEY',
    'CENTRIFUGO_API_URL',
    'CENTRIFUGO_PROXY_SECRET',
    'CENTRIFUGO_TOKEN_SECRET',
    'CRON_SECRET',
    'MEILISEARCH_HOST',
    'MEILISEARCH_MASTER_KEY',
    'NEXT_PUBLIC_CENTRIFUGO_URL',
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'NEXT_RUNTIME',
    'NEXT_TEST_MODE',
    'SENTRY_DSN',
    'SENTRY_ENVIRONMENT',
    'SENTRY_TRACES_SAMPLE_RATE',
    'STRAVA_CLIENT_ID',
    'STRAVA_CLIENT_SECRET',
  ];

  it('no NEW undeclared environment variable appears', () => {
    const declared = new Set(
      [
        ...readFileSync('src/env.ts', 'utf8').matchAll(/^\s+([A-Z][A-Z0-9_]*): process\.env\./gm),
      ].map((m) => m[1]!),
    );

    // Supplied by the platform or the test harness, not by our configuration.
    const ambient = new Set([
      'NODE_ENV',
      'VERCEL',
      'VERCEL_URL',
      'CI',
      'PORT',
      'TZ',
      'SKIP_ENV_VALIDATION',
      'npm_package_version',
    ]);

    const used = new Set<string>();
    for (const file of globSync('src/**/*.{ts,tsx}')) {
      for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        used.add(m[1]!);
      }
    }

    const undeclared = [...used].filter((n) => !declared.has(n) && !ambient.has(n)).sort();

    expect(undeclared).toEqual(UNDECLARED_RATCHET);
  });

  it('the ratchet shrinks — an entry that gets declared must leave the list', () => {
    // Without this the list rots into a permanent allowlist that still passes
    // long after the variables were fixed.
    const declared = new Set(
      [
        ...readFileSync('src/env.ts', 'utf8').matchAll(/^\s+([A-Z][A-Z0-9_]*): process\.env\./gm),
      ].map((m) => m[1]!),
    );

    expect(UNDECLARED_RATCHET.filter((n) => declared.has(n))).toEqual([]);
  });
});
