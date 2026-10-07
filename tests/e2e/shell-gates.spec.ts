import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { THEME_COOKIE } from '../../src/lib/theme-constants';
import bg from '../../messages/bg.json';

import { expect, test } from './fixtures';
import { prisma } from './utils/create-isolated-tenant';

/**
 * The two shell gates T19 added, pinned where a person meets them (#317).
 *
 * Both layouts answer 404 when the shell would have nothing to show: the club
 * admin for a member whose role opens none of its pages (a PLAYER), and the
 * platform tree for anyone without a grant carrying a capability its nav
 * offers. `nav-config.test.tsx` covers `visibleSections` as a function; this
 * covers the layouts that call it. Pages and APIs still authorise themselves,
 * so a regression here shows a shell, not data.
 */

const ADMIN_PAGES = ['calendar', 'courts', 'pricing', 'players', 'staff', 'reports'] as const;

async function status(page: Page, path: string): Promise<number | undefined> {
  return (await page.goto(path))?.status();
}

/** The same rules admin-shell.spec.ts holds the club shell to. */
async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  const report = results.violations
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
  expect(results.violations, `axe found:\n${report}`).toEqual([]);
}

test.describe('shell gates', () => {
  test('a PLAYER member of the club gets a 404 on every admin page', async ({
    isolatedTenant,
    player,
    playerPage: page,
  }) => {
    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.tenantMembership.create({
        data: {
          tenantId: isolatedTenant.tenantId,
          userId: player.userId,
          role: 'PLAYER',
          status: 'ACTIVE',
        },
      });
    });

    for (const p of ADMIN_PAGES) {
      expect({
        page: p,
        status: await status(page, `/t/${isolatedTenant.tenantSlug}/admin/${p}`),
      }).toEqual({ page: p, status: 404 });
    }
    // And no shell was drawn around the 404.
    await expect(page.locator('aside[data-collapsed]')).toHaveCount(0);
  });

  test('/platform/moderation is a 404 without a grant: a club owner', async ({
    authedPage: page,
  }) => {
    expect(await status(page, '/platform/moderation')).toBe(404);
    await expect(page.locator('aside[data-collapsed]')).toHaveCount(0);
  });

  test('/platform/moderation is a 404 without a grant: a player', async ({ playerPage: page }) => {
    expect(await status(page, '/platform/moderation')).toBe(404);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`a moderator gets the /platform shell, axe-clean, ${theme}`, async ({
      isolatedTenant,
      player,
      playerPage: page,
      baseURL,
    }) => {
      // A live REVIEW_MODERATE grant. The database refuses a self-grant, so
      // the club's owner issues it; it goes with the player's account.
      await prisma().$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
        await tx.$executeRawUnsafe(
          `INSERT INTO platform_admin_grant
             (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
           VALUES ($1,$2,$3,'e2e moderation shell check',
                   '{REVIEW_MODERATE}'::"PlatformCapability"[], now() + interval '1 day')`,
          `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          player.userId,
          isolatedTenant.userId,
        );
      });

      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      expect(await status(page, '/platform/moderation')).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main h1')).toHaveText(bg.platform.moderation.title);
      await expect(page.locator('aside[data-collapsed]')).toBeVisible();
      await expect(page.locator('main')).toHaveCount(1);

      await expectAxeClean(page);
    });
  }
});
