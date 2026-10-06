import { test as base } from './fixtures';
import {
  bookFromEmptySlot,
  cleanDeskCourt,
  seedDeskCourt,
  seriesWithOneClashSkipped,
  type DeskClub,
} from './utils/desk-booking-journey';

/**
 * Desk bookings and weekly series at 1280 px (#364), as the club's OWNER. The
 * phone half is tests/e2e/mobile/desk-bookings.spec.ts; both walk
 * utils/desk-booking-journey.ts.
 */
const test = base.extend<{ club: DeskClub }>({
  club: async ({ isolatedTenant }, use) => {
    const club = await seedDeskCourt(isolatedTenant.tenantId, isolatedTenant.tenantSlug);
    await use(club);
    await cleanDeskCourt(club);
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

test('a desk booking from a free hour, drawn on the diary as the desk’s', async ({
  authedPage,
  club,
}) => {
  await bookFromEmptySlot(authedPage, club);
});

test('a four-week series with one week taken: that week is skipped, three are booked', async ({
  authedPage,
  club,
}) => {
  await seriesWithOneClashSkipped(authedPage, club);
});
