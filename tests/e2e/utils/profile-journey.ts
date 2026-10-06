import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { streamed } from './booking-detail-journey';

/**
 * The #359 profile journey, shared by the 1280 px spec and its 393 px twin:
 * set a display name and two sports with levels on /me/profile, see them at
 * once, and see them again from the server after a reload.
 */

const p = bg.profile;

export async function setNameAndLevels(page: Page) {
  await page.goto('/me/profile');
  await streamed(page);

  // The fixture's player is named; change it.
  await page.getByTestId('profile-name-edit').click();
  const input = page.getByTestId('profile-name-input');
  await input.fill('  Иво   Иванов ');
  const saved = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/me' && r.request().method() === 'PATCH',
  );
  await page.getByTestId('profile-name-save').click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId('profile-name')).toHaveText('Иво Иванов');
  await expect(page.getByRole('heading', { level: 1, name: 'Иво Иванов' })).toBeVisible();

  // Sports: padel at 6, tennis at the default then 2.
  await expect(page.getByTestId('profile-sports')).toContainText(p.sports.none);
  await page.getByTestId('profile-sports-edit').click();
  const padel = page.getByTestId('profile-sport-pick-PADEL');
  await padel.getByRole('checkbox').click();
  await padel.getByRole('radio', { name: '6', exact: true }).click();
  await expect(page.getByTestId('profile-sport-pick-PADEL-meaning')).toContainText(
    p.sports.level['6'],
  );
  const tennis = page.getByTestId('profile-sport-pick-TENNIS');
  await tennis.getByRole('checkbox').click();
  await tennis.getByRole('radio', { name: '2', exact: true }).click();
  const sportsSaved = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/me' && r.request().method() === 'PATCH',
  );
  await page.getByTestId('profile-sports-save').click();
  expect((await sportsSaved).status()).toBe(200);

  await expect(page.getByTestId('profile-sport-PADEL')).toContainText('Ниво 6');
  await expect(page.getByTestId('profile-sport-TENNIS')).toContainText(p.sports.level['2']);

  // From the server: a fresh document load.
  await page.reload();
  await streamed(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Иво Иванов' })).toBeVisible();
  await expect(page.getByTestId('profile-sport-PADEL')).toContainText(p.sports.level['6']);
  await expect(page.getByTestId('profile-sport-TENNIS')).toContainText('Ниво 2');
}
