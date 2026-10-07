import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import {
  FACEBOOK_EMAIL_REQUIRED_REDIRECT,
  FACEBOOK_GRAPH_VERSION,
} from '../../../src/lib/auth/facebook';
import { E2E_FACEBOOK_APP_ID } from './e2e-facebook';
import { expectAxeClean, expectNoDrift } from './landing-journey';

/**
 * "Вход с Facebook" (#361), shared by the 1280 px spec and its 393 px twin.
 *
 * ═══ A POSITIVE CHECK OF WHAT THE APP SENDS, AND NOTHING REACHES FACEBOOK ═══
 *
 * The click is real: the button, next-auth's CSRF-protected POST, the redirect.
 * What Meta would receive is read off the browser's request to the Login
 * Dialog, which this answers itself — so the assertions are about the URL the
 * app actually built (version, `redirect_uri`, `scope`, `client_id`, `state`),
 * not about the absence of some error page. Every other request to Meta's
 * hosts is aborted and recorded, and recording any fails the journey.
 *
 * The server runs with a placeholder Meta app (`e2e-facebook.ts`); even if a
 * request escaped, it could not sign anyone in.
 */

const META_HOSTS =
  /^https:\/\/([a-z0-9-]+\.)*(facebook\.com|facebook\.net|fbcdn\.net|fbsbx\.com)\//i;
const DIALOG = `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`;

/** Answer the Login Dialog with a stub, abort anything else Meta's. Returns both logs. */
export async function interceptFacebook(page: Page) {
  const dialog: URL[] = [];
  const stray: string[] = [];
  await page.route(META_HOSTS, async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${DIALOG}?`)) {
      dialog.push(new URL(url));
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Facebook, intercepted</title><p>intercepted</p>',
      });
    } else {
      stray.push(url);
      await route.abort();
    }
  });
  return { dialog, stray };
}

/** /login offers "Вход с Facebook" beside nothing broken: Meta's 16 px minimum, axe-clean, no drift. */
export async function expectFacebookButton(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);

  const button = page.getByRole('button', { name: bg.login.withFacebook });
  await expect(button).toBeVisible();
  // Meta's logo rules: at least 16 px wide on screen.
  const mark = await button.locator('svg').first().boundingBox();
  expect(mark?.width ?? 0).toBeGreaterThanOrEqual(16);
  // And never the Microsoft button that used to sit here.
  await expect(page.getByRole('button', { name: /Microsoft/ })).toHaveCount(0);

  await expectAxeClean(page);
  await expectNoDrift(page);
  return button;
}

/**
 * What the Login Dialog request carried. `NEXTAUTH_URL` is the origin
 * next-auth builds the callback from — CI sets it; a local run must too.
 */
export function expectDialogRequest(url: URL, nextAuthUrl: string) {
  expect(`${url.origin}${url.pathname}`).toBe(DIALOG);
  expect(url.searchParams.get('redirect_uri')).toBe(`${nextAuthUrl}/api/auth/callback/facebook`);
  expect(url.searchParams.get('scope')?.split(/[ ,]+/)).toContain('email');
  expect(url.searchParams.get('client_id')).toBe(E2E_FACEBOOK_APP_ID);
  expect(url.searchParams.get('response_type')).toBe('code');
  // The CSRF defence of the callback: next-auth's `state` check.
  expect(url.searchParams.get('state')).toMatch(/^\S{16,}$/);
}

/** Click "Вход с Facebook" and return the Login Dialog request it produced. */
export async function clickFacebook(page: Page, next: string) {
  const meta = await interceptFacebook(page);
  const button = await expectFacebookButton(page, next);

  await button.click();
  await expect.poll(() => meta.dialog.length).toBe(1);
  await page.waitForURL((u) => u.toString().startsWith(DIALOG));
  expect(meta.stray).toEqual([]);
  return meta.dialog[0]!;
}

/**
 * Facebook sent no email address. The callback refuses through next-auth's
 * sign-in route — the exact redirect the sign-in callback returns — which
 * lands on /login with the refusal and the destination the person started
 * from. "Try again" asks Meta for the declined permission again.
 *
 * A real refusal needs Meta's callback, which no test can produce; the route
 * it ends in is the part this drives for real.
 */
export async function refusedForNoEmail(page: Page, next: string, nextAuthUrl: string) {
  const meta = await interceptFacebook(page);
  // Start where a real attempt starts, so next-auth holds the destination in
  // its callback-url cookie, as it would at the callback.
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByRole('button', { name: bg.login.withFacebook }).click();
  await expect.poll(() => meta.dialog.length).toBe(1);

  await page.goto(FACEBOOK_EMAIL_REQUIRED_REDIRECT);
  await expect(page).toHaveURL(/\/login\?/);
  const landed = new URL(page.url());
  expect(landed.searchParams.get('error')).toBe('FacebookEmailRequired');
  expect(landed.searchParams.get('callbackUrl')).toBe(`${nextAuthUrl}${next}`);

  const notice = page.getByTestId('login-facebook-email-required');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(bg.login.facebookEmail.title);
  await expectAxeClean(page);
  await expectNoDrift(page);

  await page.getByRole('button', { name: bg.login.facebookEmail.retry }).click();
  await expect.poll(() => meta.dialog.length).toBe(2);
  const retry = meta.dialog[1]!;
  expectDialogRequest(retry, nextAuthUrl);
  expect(retry.searchParams.get('auth_type')).toBe('rerequest');
  expect(meta.stray).toEqual([]);
}
