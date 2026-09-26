import { readFileSync } from 'node:fs';

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
