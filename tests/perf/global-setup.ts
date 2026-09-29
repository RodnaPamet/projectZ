import { mkdirSync } from 'node:fs';

import { request } from '@playwright/test';

import {
  AUTH_DIR,
  authStatePath,
  CLUB_SLUG,
  PERF_BASE_URL,
  PERF_PASSWORD,
  PERSONAS,
  type PersonaId,
} from './config';

/**
 * Sign each persona in ONCE, and save the session for every browser context
 * that follows.
 *
 * ═══ THROUGH THE REAL SIGN-IN, NOT A MINTED COOKIE ═══
 *
 * This POSTs to next-auth's credentials callback, exactly as the e2e
 * `authedPage` fixture does (tests/e2e/fixtures.ts). The web login form no
 * longer offers email and password, but the provider is still registered for
 * the native app (src/auth.ts). A real sign-in runs the real jwt callback. It
 * creates the `user_session` row that `checkSession` verifies on every page,
 * and it builds the membership claims the middleware reads.
 *
 * A cookie minted from NEXTAUTH_SECRET would have to copy all of that by hand,
 * and would fail `checkSession` as soon as the copy drifted. It would also be
 * a second implementation of sign-in, living in a test. Nothing is added to
 * the app for this.
 *
 * ═══ ONCE, THEN REUSED ═══
 *
 * The credentials POST is limited to ten per IP per fifteen minutes
 * (LOGIN_LIMIT). Signing in per browser context would hit that limit by the
 * third journey. A fresh context that loads this storage state still has a
 * cold HTTP cache, a cold router cache and no JS loaded. It just is not
 * signed out.
 */
/**
 * Every page the journeys visit, requested before anything is timed.
 *
 * A freshly started `next start` loads each route's server chunk, and the V8
 * code behind it, on the first request for that route. Measured on this
 * harness's first trial: the first client navigation to /venues waited about
 * 100 ms longer for its RSC response than the second. A production server has
 * long since served those routes, so the first run's cold samples would have
 * measured the Node process instead of the app. Each page is fetched as HTML
 * and as an RSC payload, since the two render paths differ.
 */
const WARM_UP: Record<'anonymous' | PersonaId, string[]> = {
  anonymous: ['/', '/venues', '/login'],
  player: ['/', '/venues', '/me/bookings', '/start'],
  staff: [
    `/t/${CLUB_SLUG}`,
    ...['calendar', 'courts', 'pricing', 'players', 'staff'].map(
      (p) => `/t/${CLUB_SLUG}/admin/${p}`,
    ),
    `/t/${CLUB_SLUG}/admin/calendar?day=2000-01-01`,
    '/start',
  ],
};

async function warmUp(who: 'anonymous' | PersonaId) {
  const ctx = await request.newContext({
    baseURL: PERF_BASE_URL,
    storageState: who === 'anonymous' ? undefined : authStatePath(who),
  });
  try {
    for (let round = 0; round < 3; round++) {
      for (const path of WARM_UP[who]) {
        await ctx.get(path, { maxRedirects: 0 });
        await ctx.get(path, { maxRedirects: 0, headers: { RSC: '1' } });
      }
    }
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup() {
  mkdirSync(AUTH_DIR, { recursive: true });

  for (const id of Object.keys(PERSONAS) as PersonaId[]) {
    const { email } = PERSONAS[id];
    const ctx = await request.newContext({ baseURL: PERF_BASE_URL });
    try {
      const { csrfToken } = (await (await ctx.get('/api/auth/csrf')).json()) as {
        csrfToken: string;
      };

      const res = await ctx.post('/api/auth/callback/credentials', {
        form: { email, password: PERF_PASSWORD, csrfToken, json: 'true' },
      });
      if (!res.ok()) {
        throw new Error(`sign-in as ${id} (${email}) answered ${res.status()}`);
      }

      // Proof, not hope: the session must name the account we asked for.
      const session = (await (await ctx.get('/api/auth/session')).json()) as {
        user?: { email?: string };
      };
      if (session.user?.email !== email) {
        throw new Error(
          `sign-in as ${id} did not produce a session for ${email} ` +
            `(got ${JSON.stringify(session)}). Did the seed run?`,
        );
      }

      await ctx.storageState({ path: authStatePath(id) });
    } finally {
      await ctx.dispose();
    }
  }

  await warmUp('anonymous');
  for (const id of Object.keys(PERSONAS) as PersonaId[]) await warmUp(id);
}
