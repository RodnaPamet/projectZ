import { test as base } from './fixtures';
import {
  cleanFeeClub,
  readStatementAndDownload,
  seedFeeClub,
  switchToThisMonth,
  type FeeClub,
} from './utils/club-fee-journey';

/**
 * "Отчети и такса" at 1280 px (#372), as the club's OWNER. The phone half is
 * tests/e2e/mobile/club-fees.spec.ts; both walk utils/club-fee-journey.ts.
 */
const test = base.extend<{ club: FeeClub }>({
  club: async ({ isolatedTenant }, use) => {
    const club = await seedFeeClub(isolatedTenant.tenantId, isolatedTenant.tenantSlug);
    await use(club);
    await cleanFeeClub(club);
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

test('the owner reads September’s statement and downloads its CSV', async ({
  authedPage,
  club,
}) => {
  await readStatementAndDownload(authedPage, club, false);
});

test('picking this month in the month picker shows an empty statement', async ({
  authedPage,
  club,
}) => {
  await switchToThisMonth(authedPage, club);
});
