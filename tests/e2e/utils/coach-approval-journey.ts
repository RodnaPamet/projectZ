import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Browser, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { totpAt } from '../../../src/lib/auth/totp';
import { expect, signIn, testClientIp } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import { prisma } from './create-isolated-tenant';
import { createPlayer, destroyPlayer, type E2EPlayer } from './create-player';
import { streamed } from './streamed';

/**
 * A coach's profile from empty to approved (#545), as the desktop and the
 * phone spec both run it: the coach fills it in, uploads a certificate and
 * sends it; the platform owner sets up two-step verification, downloads the
 * certificate from the queue, and approves; the coach sees it.
 */

const t = bg.coachProfile;
const p = bg.platform.coaches;

export const CERTIFICATE = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('Лиценз на треньор №123, издаден на E2E Coach'),
]);
export const BIO = 'Треньор по тенис от 2010 г. Работя с начинаещи и с напреднали играчи.';

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

/** The coach: fill in, upload, send. Ends on a profile that is waiting. */
export async function fillInAndSend(page: Page, opts: { shots?: string; tag: string }) {
  await page.goto('/me/coach');
  await streamed(page);
  const root = page.getByTestId('coach-profile');
  await expect(root).toHaveAttribute('data-state', 'NONE');
  await expect(page.getByRole('heading', { level: 1, name: t.title, exact: true })).toBeVisible();
  await expect(page.getByTestId('coach-profile-missing')).toBeVisible();
  await expectAxeClean(page);
  await shot(page, opts.shots, `coach-${opts.tag}-1-empty`);

  await page.getByTestId('coach-profile-bio').fill(BIO);
  await page.getByTestId('coach-profile-qualifications').fill('Лиценз ББФТ, ниво 2');
  const tennis = page.getByTestId('coach-sport-TENNIS');
  await tennis.getByRole('checkbox').check();
  await tennis
    .getByRole('radiogroup', { name: 'Тенис: до ниво' })
    .getByRole('radio', { name: '5', exact: true })
    .click();
  await expect(page.getByTestId('coach-sport-TENNIS-range')).toHaveText('нива 1–5');

  await page.getByTestId('coach-profile-certificate-input').setInputFiles({
    name: 'Лиценз ББФТ.pdf',
    mimeType: 'application/pdf',
    buffer: CERTIFICATE,
  });
  await page.getByTestId('coach-profile-certificate-upload').click();
  await expect(page.getByTestId('coach-profile-certificate-file')).toContainText('Лиценз ББФТ.pdf');
  // The upload made the profile (a draft). The text is still only on screen,
  // and the upload's answer did not wipe it.
  await expect(root).toHaveAttribute('data-state', 'DRAFT');
  await expect(page.getByTestId('coach-profile-bio')).toHaveValue(BIO);
  await expect(page.getByTestId('coach-sport-TENNIS-range')).toHaveText('нива 1–5');
  await shot(page, opts.shots, `coach-${opts.tag}-2-filled`);

  // "Send" saves what was typed first, then sends.
  await page.getByTestId('coach-profile-submit').click();
  await expect(root).toHaveAttribute('data-state', 'SUBMITTED');
  await expect(page.getByTestId('coach-profile-state')).toContainText(t.state.SUBMITTED.title);
  await expect(page.getByTestId('coach-profile-bio')).toBeDisabled();
  await expect(page.getByTestId('coach-profile-certificate-locked')).toBeVisible();
  await expectAxeClean(page);
  await shot(page, opts.shots, `coach-${opts.tag}-3-waiting`);

  // It survives a reload: what is shown is what the server holds.
  await page.reload();
  await streamed(page);
  await expect(page.getByTestId('coach-profile')).toHaveAttribute('data-state', 'SUBMITTED');
  await expect(page.getByTestId('coach-profile-bio')).toHaveValue(BIO);
}

export interface Owner {
  account: E2EPlayer;
  page: Page;
  close: () => Promise<void>;
}

/**
 * The platform owner, in a browser of their own: an account with a live
 * COACH_APPROVE grant (issued by `granterId`: the database refuses a
 * self-grant), signed in.
 */
export async function signInOwner(
  browser: Browser,
  granterId: string,
  contextOptions: Parameters<Browser['newContext']>[0] = {},
): Promise<Owner> {
  const account = await createPlayer();
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.$executeRawUnsafe(
      `INSERT INTO platform_admin_grant
         (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
       VALUES ($1,$2,$3,'e2e coach approval journey',
               '{COACH_APPROVE}'::"PlatformCapability"[], now() + interval '1 day')`,
      `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      account.userId,
      granterId,
    );
  });
  const context = await browser.newContext({
    ...contextOptions,
    // Its own client address: the mutation budget is per address.
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const page = await context.newPage();
  await signIn(page, account);
  return {
    account,
    page,
    close: async () => {
      await context.close();
      await destroyPlayer(account.userId);
    },
  };
}

/** Turn on two-step verification the way a person does, which also steps this session up. */
async function enrolSecondFactor(page: Page) {
  await page.goto('/platform/security');
  await streamed(page);
  await page.getByRole('button', { name: bg.platform.security.enrol.start, exact: true }).click();
  const key = (await page.locator('code').first().innerText()).replace(/\s/g, '');
  await page.getByLabel(bg.platform.security.enrol.codeLabel).fill(totpAt(key, Date.now()));
  await page.getByRole('button', { name: bg.platform.security.enrol.confirm, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: bg.platform.security.recovery.title }).first(),
  ).toBeVisible();
}

/**
 * The owner: without a second factor the queue asks for one; with it, the
 * coach's profile is there, the certificate downloads exactly as uploaded,
 * and approving removes the card.
 */
export async function approveFromQueue(
  owner: Owner,
  coach: { userId: string; name: string },
  opts: { shots?: string; tag: string },
) {
  const { page } = owner;
  await page.goto('/platform/coaches');
  await streamed(page);
  await expect(page.getByRole('heading', { level: 1, name: p.title, exact: true })).toBeVisible();
  // No second factor yet: sent to set one up, and offered no form.
  await expect(page.getByText(p.error.MFA_ENROLMENT_REQUIRED, { exact: false })).toBeVisible();
  await expect(page.getByLabel(p.reason.label)).toHaveCount(0);

  await enrolSecondFactor(page);
  await page.goto('/platform/coaches');
  await streamed(page);
  await page.getByLabel(p.reason.label).fill('e2e: approving the coach who just applied');
  await page.getByRole('button', { name: p.open, exact: true }).click();

  // By the account, not by the text: another run's coach may be waiting too.
  const card = page.locator(`[data-testid="coach-card"][data-coach="${coach.userId}"]`);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(coach.name);
  await expect(card).toContainText(BIO);
  await expect(card).toContainText('Тенис: нива 1–5');
  await expect(card).toContainText('Лиценз ББФТ, ниво 2');
  await expect(card).toContainText('Лиценз ББФТ.pdf');
  await expectAxeClean(page);
  await shot(page, opts.shots, `owner-${opts.tag}-1-queue`);

  // The certificate: a download, byte for byte what the coach uploaded.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByTestId('coach-certificate-open').click(),
  ]);
  expect(download.suggestedFilename()).toBe('Лиценз ББФТ.pdf');
  expect(Buffer.compare(await readFile(await download.path()), CERTIFICATE)).toBe(0);

  // A decision needs a note.
  await expect(card.getByTestId('coach-approve')).toBeDisabled();
  await card.getByLabel(p.note.label).fill('Лицензът е проверен в регистъра.');
  await card.getByTestId('coach-approve').click();
  await expect(page.getByTestId('coaches-notice')).toHaveText(p.done.APPROVE);
  await expect(card).toHaveCount(0);
  await shot(page, opts.shots, `owner-${opts.tag}-2-approved`);
}

/** The coach again: approved, told in the bell's table, text editable, certificate locked. */
export async function seesApproval(
  page: Page,
  coachId: string,
  opts: { shots?: string; tag: string },
) {
  await page.goto('/me/coach');
  await streamed(page);
  await expect(page.getByTestId('coach-profile')).toHaveAttribute('data-state', 'APPROVED');
  await expect(page.getByTestId('coach-profile-state')).toContainText(t.state.APPROVED.title);
  await expect(page.getByTestId('coach-profile-bio')).toBeEnabled();
  await expect(page.getByTestId('coach-profile-certificate-locked')).toHaveText(
    t.certificate.lockedApproved,
  );
  await expect(page.getByTestId('coach-profile-submit')).toHaveCount(0);
  await expectAxeClean(page);
  await shot(page, opts.shots, `coach-${opts.tag}-4-approved`);

  const told = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.notification.findMany({
      where: { userId: coachId, kind: 'COACH_PROFILE_APPROVED' },
      select: { title: true, href: true },
    });
  });
  expect(told).toEqual([{ title: bg.notifications.coach.approved.title, href: '/me/coach' }]);
}

/** What the coach's rows leave behind is not tied to the account by a key: clear it. */
export async function clearCoach(userId: string) {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.coachCertificate.deleteMany({ where: { userId } });
    await tx.coachProfile.deleteMany({ where: { userId } });
  });
}
