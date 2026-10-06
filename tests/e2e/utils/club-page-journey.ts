import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';
import type { BookableVenue } from './seed-bookable-venue';

/**
 * The /venues filters (#357) and the public club page (#356), shared by the
 * 1280 px specs and their 393 px twins so both widths walk the same steps.
 */
const f = bg.venues.filters;

/** A live venue with one padel court open all day, at the club `tenantId`. */
export interface ClubVenue {
  venueId: string;
  name: string;
  publicSlug: string;
}

export async function seedClubVenue(tenantId: string, tag: string): Promise<ClubVenue> {
  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const venue = await tx.venue.create({
      data: {
        tenantId,
        slug: `e2e-club-venue-${tag}`,
        name: `E2E Обект ${tag}`,
        addressLine: 'ул. Корт 1',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `club-venue-${tag}@playerz.test`,
        phone: '+359 2 123 4567',
        timezone: 'Europe/Sofia',
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId,
        venueId: venue.id,
        name: 'Корт 1',
        sport: 'PADEL',
        surface: 'ARTIFICIAL_GRASS',
        basePriceCents: 2400,
        minBookingMinutes: 60,
        maxBookingMinutes: 120,
        slotStepMinutes: 60,
      },
    });
    await tx.resourceAvailability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        tenantId,
        resourceId: court.id,
        dayOfWeek,
        openTime: new Date('1970-01-01T00:00:00Z'),
        closeTime: new Date('1970-01-01T23:59:00Z'),
      })),
    });
    const row = await tx.venue.findUniqueOrThrow({
      where: { id: venue.id },
      select: { publicSlug: true },
    });
    return { venueId: venue.id, name: venue.name, publicSlug: row.publicSlug! };
  });
}

/** `venue.tenantId` is not a foreign key: the venue does not go with the club. */
export async function destroyClubVenue(v: ClubVenue): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venue.deleteMany({ where: { id: v.venueId } });
  });
}

/** Resolves when `GET /api/v1/venues` answers for a key carrying `param=value`. */
function venuesRead(page: Page, param: string, value: string) {
  return page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/v1/venues' &&
      new URL(r.url()).searchParams.get(param) === value &&
      r.ok(),
  );
}

/**
 * /venues → Падел → София → the venue's tag in the search → open it.
 *
 * Every filter is a URL change WITHOUT a document load (#357): a marker put
 * on `window` before the first filter is still there at the end. The search
 * narrows to this one venue, because other specs add Sofia padel venues in
 * parallel and the list shows twenty.
 */
export async function filterToVenue(page: Page, venue: BookableVenue) {
  await page.goto('/venues');
  await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));

  const sports = page.getByRole('radiogroup', { name: f.sport });
  const bySport = venuesRead(page, 'sport', 'PADEL');
  await sports.getByRole('radio', { name: bg.sports.PADEL }).click();
  await expect(page).toHaveURL(/[?&]sport=PADEL(&|$)/);
  await bySport;
  await expect(sports.getByRole('radio', { name: bg.sports.PADEL })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  const byCity = venuesRead(page, 'city', 'Sofia');
  await page.getByRole('combobox', { name: `${f.city}, ${f.allCities}` }).click();
  await page.getByRole('option', { name: bg.cities.sofia }).click();
  await expect(page).toHaveURL(/[?&]city=Sofia(&|$)/);
  await byCity;
  await expect(page.getByRole('combobox', { name: `${f.city}, ${bg.cities.sofia}` })).toBeVisible();

  const tag = venue.venueName.split(' ').at(-1)!;
  const byText = venuesRead(page, 'q', tag);
  await page.getByRole('searchbox', { name: f.search }).fill(tag);
  await byText;
  await expect(page).toHaveURL(new RegExp(`[?&]q=${tag}(&|$)`));

  const main = page.getByRole('main');
  const card = main.getByRole('listitem').filter({ hasText: venue.venueName });
  await expect(card).toHaveCount(1);
  // The city in Bulgarian (A07), not "Sofia, BG".
  await expect(card.getByText(bg.cities.sofia, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(
    1,
  );

  await card.getByRole('link', { name: venue.venueName }).click();
  await expect(page).toHaveURL(new RegExp(`/venues/${venue.publicSlug}(\\?.*)?$`));
  await expect(page.getByRole('heading', { level: 1, name: venue.venueName })).toBeVisible();
}

/** On the club page: the club, its venue's card with today's times, then the venue page. */
export async function clubPageToVenue(page: Page, clubName: string, venue: ClubVenue) {
  await expect(page.getByRole('heading', { level: 1, name: clubName })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: bg.club.venuesTitle })).toBeVisible();

  const card = page.getByRole('main').getByRole('listitem').filter({ hasText: venue.name });
  await expect(card.getByText(bg.sports.PADEL).first()).toBeVisible();
  // Open all day, so today has free times — unless the spec runs after the
  // last start (22:00 at the club), when the card says there are none.
  await expect(
    card.getByText(new RegExp(`^(${bg.club.freeToday}|${bg.club.noneToday})$`)).first(),
  ).toBeVisible();

  await card.getByRole('link', { name: venue.name }).click();
  await expect(page).toHaveURL(new RegExp(`/venues/${venue.publicSlug}(\\?.*)?$`));
  await expect(page.getByRole('heading', { level: 1, name: venue.name })).toBeVisible();
}

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

/** The page never scrolls sideways at 393 px; the sports scroll inside their own strip. */
export async function expectNoDrift(page: Page) {
  const drift = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(drift).toBeLessThanOrEqual(0);
}
