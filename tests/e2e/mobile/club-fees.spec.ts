import { test as base } from '../fixtures';
import {
  cleanFeeClub,
  readStatementAndDownload,
  seedFeeClub,
  switchToThisMonth,
  type FeeClub,
} from '../utils/club-fee-journey';

/**
 * "Отчети и такса" at 393 px (#372): the same journeys as the 1280 px spec,
 * reached from the drawer, with the lines as cards and no sideways drift.
 */
const test = base.extend<{ club: FeeClub }>({
  club: async ({ isolatedTenant }, use) => {
    const club = await seedFeeClub(isolatedTenant.tenantId, isolatedTenant.tenantSlug);
    await use(club);
    await cleanFeeClub(club);
  },
});

test('the owner reads September’s statement and downloads its CSV, on a phone', async ({
  authedPage,
  club,
}) => {
  await readStatementAndDownload(authedPage, club, true);
});

test('picking this month on a phone shows an empty statement', async ({ authedPage, club }) => {
  await switchToThisMonth(authedPage, club);
});
