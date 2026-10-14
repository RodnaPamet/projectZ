import bg from '../../../messages/bg.json';
import { expect, signIn, test as base } from '../fixtures';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from '../utils/seed-bookable-venue';
import {
  confirmAndSeeIt,
  expectAxeClean,
  expectNoDrift,
  pickFirstTime,
  pickTomorrow,
} from '../utils/venue-booking-journey';

/**
 * The venue page at 393 px (Pixel 5, #355): the same journeys as the 1280 px
 * spec, plus what a phone adds — the page never scrolls sideways (the day
 * picker scrolls inside itself), the booking bar sits above the tab bar, and
 * the sheet comes up from the bottom.
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

test.describe('the venue page, 393 px', () => {
  test('browse → pick a time → confirm → it is in Резервации', async ({
    playerPage: page,
    venue,
  }) => {
    await page.goto(`/venues?q=${encodeURIComponent(venue.venueName)}`);
    await page.getByRole('link', { name: venue.venueName }).click();
    await expect(page.getByRole('heading', { level: 1, name: venue.venueName })).toBeVisible();
    await expectNoDrift(page);

    await pickTomorrow(page, venue);
    const label = await pickFirstTime(page);
    await expectNoDrift(page);

    // The booking bar is on screen, above the tab bar, without scrolling.
    const book = page.getByRole('button', { name: v.book });
    await expect(book).toBeInViewport();
    const tabs = page.getByRole('navigation').last();
    const [bookBox, tabsBox] = [await book.boundingBox(), await tabs.boundingBox()];
    if (bookBox && tabsBox) expect(bookBox.y + bookBox.height).toBeLessThanOrEqual(tabsBox.y + 1);

    await book.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('data-sheet-direction', 'bottom');

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
    expect(next.startsWith(`/venues/${venue.publicSlug}?`)).toBe(true);

    await signIn(page, player);
    await page.goto(next);
    await expect(page.getByRole('dialog')).toBeVisible();
    await confirmAndSeeIt(page, venue, label);
  });

  test('has no critical or serious accessibility violations', async ({
    playerPage: page,
    venue,
  }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await pickTomorrow(page, venue);
    await expectAxeClean(page);
  });
});

test.describe('the booking sheet on a small phone (#561)', () => {
  test('320 × 568 with the text half again as large: the details can be reached and scrolled from the keyboard', async ({
    playerPage: page,
    venue,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/venues?q=${encodeURIComponent(venue.venueName)}`);
    await page.getByRole('link', { name: venue.venueName }).click();
    await expect(page.getByRole('heading', { level: 1, name: venue.venueName })).toBeVisible();
    // A reader who has raised the text size in their browser.
    await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
    await pickTomorrow(page, venue);
    await pickFirstTime(page);
    await page.getByRole('button', { name: v.book }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(v.sheet.payAtClub)).toBeVisible();
    await dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );

    // What #561 asked to measure: does the body scroll at this size?
    const body = page.getByTestId('booking-sheet');
    const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
    test
      .info()
      .annotations.push({ type: 'booking-sheet-overflows', description: String(overflows) });
    await expectAxeClean(page);
    // Whether it scrolls or not, the details are one stop for the keyboard.
    await body.focus();
    await expect(body).toBeFocused();
  });
});
