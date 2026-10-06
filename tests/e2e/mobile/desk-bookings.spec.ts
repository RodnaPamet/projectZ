import { test as base } from '../fixtures';
import {
  bookFromEmptySlot,
  cleanDeskCourt,
  seedDeskCourt,
  seriesWithOneClashSkipped,
  type DeskClub,
} from '../utils/desk-booking-journey';

/**
 * Desk bookings and weekly series at 393 px (#364): the same journeys as the
 * 1280 px spec, in the bottom sheet a phone gets, with no sideways drift.
 */
const test = base.extend<{ club: DeskClub }>({
  club: async ({ isolatedTenant }, use) => {
    const club = await seedDeskCourt(isolatedTenant.tenantId, isolatedTenant.tenantSlug);
    await use(club);
    await cleanDeskCourt(club);
  },
});

test('a desk booking from a free hour, on a phone', async ({ authedPage, club }) => {
  await bookFromEmptySlot(authedPage, club);
});

test('a four-week series with one week skipped, on a phone', async ({ authedPage, club }) => {
  await seriesWithOneClashSkipped(authedPage, club);
});
