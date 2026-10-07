import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';
import { prisma } from './create-isolated-tenant';

/**
 * The landing page (#369) and the signed-out language switch (#368), shared by
 * the 1280 px spec and its 393 px twin so both widths walk the same steps.
 */

export async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  const report = blocking
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
  expect(blocking, `axe found ${blocking.length} blocking violation(s):\n${report}`).toEqual([]);
}

export async function expectNoDrift(page: Page) {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

/**
 * By test id, the SHOWN copy only. Under React's 300 ms reveal throttle a
 * streamed page sits in a hidden copy beside the shown one for a moment, and a
 * bare test id matches both (see #367's player-profile flake).
 */
const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

/** Wait until the page is revealed: one copy of it, not a shown and a hidden one. */
async function settled(page: Page) {
  await expect(page.getByTestId('landing-hero')).toHaveCount(1);
}

/** Every section of the page is there, in Bulgarian, with the seeded pilot clubs. */
export async function expectLanding(page: Page) {
  await page.goto('/');
  const l = bg.landing;
  await expect(page.getByRole('heading', { level: 1, name: l.hero.title })).toBeVisible();
  for (const id of ['landing-players', 'landing-pilot-clubs', 'landing-clubs', 'landing-closing']) {
    await expect(shown(page, id)).toBeVisible();
  }
  // The seed's clubs are live (active, with a public venue), so they are shown,
  // each linking to its club page.
  const clubs = shown(page, 'pilot-clubs');
  await expect(clubs.getByRole('link', { name: 'Sofia Padel Club' })).toHaveAttribute(
    'href',
    /^\/clubs\/[a-z0-9-]+$/,
  );
  await expect(shown(page, 'site-footer')).toBeVisible();
  await expectNoDrift(page);
}

/** "Намери корт" is the hero's link into /venues. */
export async function findACourt(page: Page) {
  await page.goto('/');
  const cta = shown(page, 'landing-find-court');
  await expect(cta).toHaveText(bg.landing.hero.cta);
  await cta.click();
  await expect(page).toHaveURL(/\/venues$/);
  await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
}

/**
 * Signed out, the footer's switch turns the site English and back: the
 * landing page, then /venues, which reads the same cookie.
 */
export async function switchLanguageSignedOut(page: Page) {
  await page.goto('/');
  await settled(page);
  const lang = shown(page, 'footer-language');
  await lang.scrollIntoViewIfNeeded();
  await lang.getByRole('radio', { name: 'English' }).click();
  await expect(page.getByRole('heading', { level: 1, name: en.landing.hero.title })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'NEXT_LOCALE')?.value).toBe('en');

  await page.goto('/venues');
  await expect(page.getByRole('heading', { level: 1, name: en.venues.title })).toBeVisible();

  const back = shown(page, 'footer-language');
  await back.scrollIntoViewIfNeeded();
  await back.getByRole('radio', { name: 'Български' }).click();
  await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
}

/** The "For clubs" form submits, and the enquiry is stored. */
export async function sendTheContactForm(page: Page, tag: string) {
  const f = bg.landing.clubs.form;
  // Each run its own client address: the form is rate-limited per IP (5 an
  // hour), and every spec, retry and repeat would otherwise share one bucket.
  const octet = () => Math.floor(Math.random() * 254) + 1;
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.${octet()}.${octet()}` });
  await page.goto('/#clubs');
  await settled(page);
  const form = shown(page, 'contact-form');
  await form.getByRole('textbox', { name: new RegExp(`^${f.name}`) }).fill('E2E Мария');
  await form.getByRole('textbox', { name: new RegExp(`^${f.clubName}`) }).fill(`E2E клуб ${tag}`);
  await form.getByRole('textbox', { name: new RegExp(`^${f.phone}`) }).fill('+359 88 123 4567');
  await form.getByRole('textbox', { name: new RegExp(`^${f.message}`) }).fill('Имаме 3 корта.');
  await form.getByTestId('contact-submit').click();
  await expect(shown(page, 'contact-success')).toContainText(f.success.body);

  const row = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const found = await tx.contactRequest.findFirst({ where: { clubName: `E2E клуб ${tag}` } });
    if (found) await tx.contactRequest.delete({ where: { id: found.id } });
    return found;
  });
  expect(row).toMatchObject({ name: 'E2E Мария', phone: '+359 88 123 4567', locale: 'bg' });
}
