import { expect, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';
import { expectAxeClean, expectNoDrift } from './club-page-journey';

/**
 * Venue photos (#366), shared by the 1280 px spec and its 393 px twin: the
 * owner uploads a cover under "Снимки и информация", and it shows on the
 * venue page and on the club page, as a responsive image that really loaded.
 *
 * The server runs with MEDIA_STORAGE=local (CI's E2E job sets it), so the
 * photo is served by the app's own /media route.
 */
const ph = bg.admin.photos;

/** A 1600 × 900 JPEG, made here: no binary fixture in the repo. */
export function coverJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 24, g: 120, b: 80 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** The photo rows of one venue: the spec's own cleanup (objects stay for the sweep). */
export async function destroyVenuePhotos(venueId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venuePhoto.deleteMany({ where: { venueId } });
  });
}

/** Admin → Снимки и информация → upload a cover for `venueName` with `alt`. */
export async function uploadCover(page: Page, slug: string, venueName: string, alt: string) {
  await page.goto(`/t/${slug}/admin/photos`);
  await expect(page.getByRole('heading', { level: 1, name: ph.title })).toBeVisible();
  await expect(page.getByText(ph.notConfigured.title)).toHaveCount(0);

  const card = page.getByRole('region', { name: venueName });
  const form = card.getByTestId('photo-upload-cover');
  await form.locator('input[type="file"]').setInputFiles({
    name: 'cover.jpg',
    mimeType: 'image/jpeg',
    buffer: await coverJpeg(),
  });
  await expect(form).toContainText('cover.jpg');
  await form.getByRole('textbox', { name: ph.upload.alt }).fill(alt);
  await expectNoDrift(page);

  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/admin\/venues\/[^/]+\/photos$/.test(r.url()),
  );
  await form.getByRole('button', { name: ph.upload.submit }).click();
  expect((await posted).status()).toBe(201);
  await expect(form.getByText(ph.upload.done)).toBeVisible();

  // The refreshed page shows the cover, with its alt text, and offers to replace it.
  await expect(card.getByRole('img', { name: alt })).toBeVisible();
  await expect(card.getByText(ph.cover.replace)).toBeVisible();
  await expectAxeClean(page);
}

/** The image really arrived: decoded, with a srcset the browser picked from. */
async function expectLoadedImage(img: Locator) {
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('srcset', /\/media\/venues\/.+-640\.webp 640w/);
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  const src = await img.evaluate((el: HTMLImageElement) => el.currentSrc);
  expect(src).toMatch(/\/media\/venues\/[a-z0-9]+\/[0-9a-f-]{36}-\d+\.webp$/);
}

/** The venue page's header carries the cover; the JSON-LD names it as `image`. */
export async function expectCoverOnVenuePage(page: Page, publicSlug: string, alt: string) {
  await page.goto(`/venues/${publicSlug}`);
  const header = page.getByRole('main').locator('header').first();
  await expectLoadedImage(header.getByRole('img', { name: alt }));
  const ld = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').first().textContent()) ?? '{}',
  ) as { image?: string[] };
  expect(ld.image?.[0]).toMatch(/\/media\/venues\/.+-\d+\.webp$/);
  await expectNoDrift(page);
}

/** The club page's header carries its venue's cover, and so does the venue's card. */
export async function expectCoverOnClubPage(page: Page, slug: string, alt: string) {
  await page.goto(`/clubs/${slug}`);
  const main = page.getByRole('main');
  await expectLoadedImage(main.locator('header').first().getByRole('img', { name: alt }));
  await expect(main.getByRole('listitem').getByRole('img', { name: alt })).toBeVisible();
  await expectNoDrift(page);
}
