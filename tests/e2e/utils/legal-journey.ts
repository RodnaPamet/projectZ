import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { expectAxeClean, streamed } from './booking-detail-journey';

/**
 * The legal pages, the account-deletion help and the cookie notice (#370,
 * #445), shared by the 1280 px spec and its 393 px twin.
 *
 * Nothing here assumes which legal texts exist: it reads content/legal as the
 * server does (src/lib/legal/texts.ts), so it holds both before the owner's
 * texts arrive (a real 404, no link anywhere) and after (the page, linked).
 */

const SLUGS = ['privacy', 'terms', 'cookies'] as const;
type Slug = (typeof SLUGS)[number];

/** Whether the Bulgarian text is there: a file with something in it. */
function textExists(slug: Slug): boolean {
  try {
    const file = path.join(process.cwd(), 'content', 'legal', 'bg', `${slug}.md`);
    return readFileSync(file, 'utf8').trim() !== '';
  } catch {
    return false;
  }
}

/** Where the cookie notice keeps its dismissal (src/components/layout/CookieNotice.tsx). */
const NOTICE_KEY = 'playerz:cookie-notice';

const FOOTER_LABEL: Record<Slug, string> = {
  privacy: bg.common.footer.privacy,
  terms: bg.common.footer.terms,
  cookies: bg.common.footer.cookies,
};

/** A page without its text answers a REAL 404: the status, not a streamed 200. */
export async function legalRoutes(page: Page) {
  for (const slug of SLUGS) {
    const res = await page.goto(`/${slug}`);
    if (textExists(slug)) {
      expect(res?.status(), `/${slug}`).toBe(200);
      await expect(page.getByTestId(`legal-${slug}`)).toBeVisible();
    } else {
      expect(res?.status(), `/${slug}`).toBe(404);
      await expect(page.getByTestId(`legal-${slug}`)).toHaveCount(0);
    }
  }
}

/** The footer links what exists, and how to delete an account, always. */
export async function footerLinks(page: Page) {
  await page.goto('/venues');
  await streamed(page);
  const footer = page.getByTestId('site-footer');
  await expect(footer.getByRole('link', { name: bg.common.footer.deleteAccount })).toHaveAttribute(
    'href',
    '/delete-account',
  );
  for (const slug of SLUGS) {
    await expect(footer.getByRole('link', { name: FOOTER_LABEL[slug] })).toHaveCount(
      textExists(slug) ? 1 : 0,
    );
  }
  // Nowhere on the page links to a legal page that is a 404.
  for (const slug of SLUGS) {
    if (!textExists(slug)) await expect(page.locator(`a[href="/${slug}"]`)).toHaveCount(0);
  }
}

/** The landing page's contact form: its privacy line links only to a text that exists. */
export async function contactFormLine(page: Page) {
  await page.goto('/');
  await streamed(page);
  const line = page.getByTestId('contact-privacy');
  await expect(line).toBeVisible();
  await expect(line.getByRole('link')).toHaveCount(textExists('privacy') ? 1 : 0);
}

/** /delete-account: what a person (or Meta's reviewer) reads, signed in or not. */
export async function deleteAccountHelp(page: Page, opts: { shot?: string } = {}) {
  // The page, not the cookie notice (which has its own journey below): a
  // visitor who has already hidden it.
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // A browser without storage shows the notice; the page is the same.
    }
  }, NOTICE_KEY);
  await page.goto('/delete-account');
  await streamed(page);
  const h = bg.deleteAccountHelp;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(h.title);
  for (const title of [h.where.title, h.upcoming.title, h.deleted.title, h.kept.title]) {
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
  }
  await expect(page.getByTestId('delete-account-help-profile')).toHaveAttribute(
    'href',
    '/me/profile',
  );
  await expect(page.getByTestId('delete-account-help-contact')).toHaveAttribute('href', '/#clubs');
  await expect(page).toHaveTitle(h.metaTitle);
  await expectAxeClean(page);
  if (opts.shot) await page.screenshot({ path: opts.shot });
}

/**
 * The essential-only notice, on a visitor's first visit: visible, clear of the
 * phone's tab bar and of the header, hidden on a tap, and still hidden on the
 * next visit. The reload after it is hidden proves nothing on its own (the
 * notice appears after hydration), so the same wait is shown to bring it back
 * once the browser forgets.
 */
export async function cookieNotice(page: Page, opts: { shot?: string; phone?: boolean } = {}) {
  await page.goto('/venues');
  await streamed(page);
  const notice = page.getByTestId('cookie-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(bg.common.cookieNotice.text);
  await expect(notice.getByRole('button')).toHaveCount(1);

  const box = (await notice.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  const header = (await page.getByRole('banner').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  if (opts.phone) {
    const bar = (await page.getByTestId('bottom-tab-bar').boundingBox())!;
    // Above the bar, never over a tab.
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  }
  await expectAxeClean(page);
  if (opts.shot) await page.screenshot({ path: opts.shot });

  // At the end of the page it has its own room: the footer's language switch,
  // the last control a visitor reaches, is never left beneath it.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(async () => {
    const lang = (await page.getByTestId('footer-language').boundingBox())!;
    const settled = (await notice.boundingBox())!;
    expect(lang.y + lang.height).toBeLessThanOrEqual(settled.y);
    if (opts.phone) {
      const bar = (await page.getByTestId('bottom-tab-bar').boundingBox())!;
      expect(settled.y + settled.height).toBeLessThanOrEqual(bar.y);
    }
  }).toPass();
  await page.getByTestId('footer-language').getByRole('radio', { name: 'English' }).click({
    trial: true,
  });

  await notice.getByRole('button', { name: bg.common.cookieNotice.dismiss }).click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), NOTICE_KEY)).toBe('dismissed');
  // The choice stays in this browser: no cookie was set for it.
  expect((await page.context().cookies()).map((c) => c.name)).not.toContain(
    'playerz_cookie-notice',
  );

  await page.reload();
  await streamed(page);
  await page.waitForLoadState('networkidle');
  await expect(notice).toHaveCount(0);

  // The control: the same visit, forgotten, shows it again.
  await page.evaluate((k) => window.localStorage.removeItem(k), NOTICE_KEY);
  await page.reload();
  await streamed(page);
  await expect(notice).toBeVisible();
}

/** A signed-in account's shell carries no notice: it is a visitor's. */
export async function noNoticeInTheShell(page: Page) {
  await page.goto('/me/bookings');
  await streamed(page);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-app-shell]')).toHaveCount(1);
  await expect(page.getByTestId('cookie-notice')).toHaveCount(0);
}
