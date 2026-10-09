import bg from '../../messages/bg.json';
import { expect, signIn, test as base } from './fixtures';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from './utils/seed-bookable-venue';
import {
  confirmAndSeeIt,
  expectAxeClean,
  pickFirstTime,
  pickTomorrow,
} from './utils/venue-booking-journey';
import { settleAnimations } from './utils/settle-animations';

/**
 * The venue page at 1280 px (#355): from a card on /venues to a booking in
 * Резервации, and the signed-out round trip through sign-in. The 393 px twin
 * is mobile/venue-booking.spec.ts.
 *
 * `venue` depends on `player` so it is torn down FIRST: the player's booking
 * goes with the club before the account it names.
 */
const v = bg.venue;
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({ player }, use) => {
    void player;
    const venue = await seedBookableVenue();
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('the venue page, 1280 px', () => {
  test('browse → pick a time → confirm → it is in Резервации', async ({
    playerPage: page,
    venue,
  }) => {
    await page.goto(`/venues?q=${encodeURIComponent(venue.venueName)}`);
    await page.getByRole('link', { name: venue.venueName }).click();

    await expect(page).toHaveURL(new RegExp(`/venues/${venue.publicSlug}(\\?|$)`));
    await expect(page.getByRole('heading', { level: 1, name: venue.venueName })).toBeVisible();

    await pickTomorrow(page, venue);
    const label = await pickFirstTime(page);
    await page.getByRole('button', { name: v.book }).click();

    await confirmAndSeeIt(page, venue, label);
  });

  test('signed out: Резервирай goes to sign-in and back to the same time', async ({
    page,
    player,
    venue,
  }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await pickTomorrow(page, venue);
    const label = await pickFirstTime(page);
    await page.getByRole('button', { name: v.book }).click();

    await expect(page).toHaveURL(/\/login\?next=/);
    const next = new URL(page.url()).searchParams.get('next')!;
    // A path on this site, back to this venue, this time, with the sheet open.
    expect(next.startsWith(`/venues/${venue.publicSlug}?`)).toBe(true);
    expect(new URLSearchParams(next.split('?')[1]).get('confirm')).toBe('1');

    // The login page offers federated sign-in only, so the round trip is
    // finished programmatically: sign in, then go where /login would send us.
    await signIn(page, player);
    await page.goto(next);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The time row STARTS with it ("08:00–09:00"). A bare substring also
    // matched the cancel deadline between midnight and 08:00 at the club
    // ("…до сряда, 7 октомври в 08:00"), a strict-mode failure only at night.
    await expect(dialog.getByText(new RegExp(`^${label.slice(0, 5)}–`))).toBeVisible();
    await confirmAndSeeIt(page, venue, label);
  });

  test('an unknown venue is the not-found page, kept out of search', async ({ page }) => {
    // Not a 404 status: loading.tsx (T12) starts the stream before the page
    // knows, and Next then marks the page noindex instead (see page.tsx).
    await page.goto('/venues/no-such-venue-anywhere');
    await expect(page.getByRole('heading', { name: bg.notFound.title })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content="noindex"]').first()).toBeAttached();
  });

  test('has no critical or serious accessibility violations, sheet open too', async ({
    playerPage: page,
    venue,
  }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await pickTomorrow(page, venue);
    await expectAxeClean(page);

    await pickFirstTime(page);
    await page.getByRole('button', { name: v.book }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await settleAnimations(page.getByRole('dialog'));
    await expectAxeClean(page);
  });

  test('carries a canonical URL and a description for search engines', async ({ page, venue }) => {
    await page.goto(`/venues/${venue.publicSlug}?day=2099-01-01`);
    await expect(page).toHaveTitle(new RegExp(venue.venueName));
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(new RegExp(`/venues/${venue.publicSlug}$`));
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      new RegExp(venue.venueName),
    );
  });
});
