import { test as base, expect } from '@playwright/test';

import {
  createIsolatedTenant,
  destroyTenant,
  type IsolatedTenant,
} from './utils/create-isolated-tenant';
import { createPlayer, destroyPlayer, type E2EPlayer } from './utils/create-player';

/**
 * The E2E fixture spine.
 *
 * `fullyParallel` is on, so mutating specs MUST NOT share a tenant — two
 * specs booking "the last slot" on the same court would race and flake in
 * a way that looks like a product bug. `isolatedTenant` gives each spec its
 * own VenueOrg and tears it down afterwards. Read-only specs can use the
 * shared seed instead and skip the setup cost.
 */

interface Fixtures {
  isolatedTenant: IsolatedTenant;
  authedPage: import('@playwright/test').Page;
  /** A PLAYER account (T20), with no club. */
  player: E2EPlayer;
  /** `page`, signed in as `player`. */
  playerPage: import('@playwright/test').Page;
}

export const test = base.extend<Fixtures>({
  isolatedTenant: async ({}, use) => {
    const tenant = await createIsolatedTenant();
    await use(tenant);
    // Runs even if the spec failed — a crashed spec must not leak a tenant
    // into the next run's data.
    await destroyTenant(tenant.tenantId);
  },

  authedPage: async ({ page, isolatedTenant }, use) => {
    // Programmatic sign-in, not a UI login. Driving the login form in every
    // spec makes each of them a login test too — so a broken login page
    // fails 40 unrelated specs and buries the real signal. P07 wires the
    // NextAuth credentials endpoint this posts to.
    await signIn(page, isolatedTenant);
    await use(page);
  },

  player: async ({}, use) => {
    const player = await createPlayer();
    await use(player);
    await destroyPlayer(player.userId);
  },

  playerPage: async ({ page, player }, use) => {
    await signIn(page, player);
    await use(page);
  },
});

export async function signIn(
  page: import('@playwright/test').Page,
  account: { email: string; password: string },
): Promise<void> {
  const res = await page.request.post('/api/auth/callback/credentials', {
    // A distinct client address per sign-in. The credentials POST allows 10
    // attempts per IP per 15 minutes (LOGIN_LIMIT), keyed on the first
    // x-forwarded-for hop, and every spec signs in from the same loopback:
    // T19's 13 authed specs measured 429 from the eleventh. 198.18.0.0/15
    // is the benchmarking range (RFC 2544), so it never names a real client.
    headers: { 'x-forwarded-for': testClientIp() },
    form: {
      email: account.email,
      password: account.password,
      csrfToken: await csrfToken(page),
      json: 'true',
    },
  });

  if (!res.ok()) {
    throw new Error(
      `Programmatic sign-in failed (${res.status()}). The sign-in fixture ` +
        `cannot proceed; check the NextAuth credentials provider.`,
    );
  }
}

function testClientIp(): string {
  const n = Math.floor(Math.random() * 2 ** 17);
  return `198.${18 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
}

async function csrfToken(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/auth/csrf');
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

export { expect };
