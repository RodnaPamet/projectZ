import { NextRequest } from 'next/server';

import { POST as sweepRoute } from '@/app/api/cron/sweep-orphan-media/route';
import {
  DRAFT_CERTIFICATE_KEPT_DAYS,
  sweepStaleCertificates,
} from '@/app-layer/usecases/coach-certificate-retention';

import { prismaTestClient, resetDatabase, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A certificate nobody will look at is not kept (#557; owner decision 28):
 * on a profile DRAFT or DECLINED for 30 days with no change, the daily sweep
 * deletes it. Waiting for a decision, or approved, it stays.
 */
const db = prismaTestClient();
const DAY = 86_400_000;

/** A coach with a profile in this state and a certificate of `bytes`, both `ageDays` old. */
async function coachWith(
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' | null,
  ageDays: number,
  bytes = 1000,
): Promise<string> {
  const userId = await seedAccount('COACH', db);
  const admin = await seedAccount('PLAYER', db);
  await asAppSuperuser(db, async (tx) => {
    if (status) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
      const decided = status === 'APPROVED' || status === 'DECLINED';
      await tx.coachProfile.create({
        data: {
          userId,
          slug: `c-${userId.slice(-10).toLowerCase()}`,
          status,
          ...(status !== 'DRAFT' ? { submittedAt: new Date() } : {}),
          ...(decided ? { decidedAt: new Date(), decidedByUserId: admin } : {}),
        },
      });
    }
    await tx.coachCertificate.create({
      data: {
        userId,
        fileName: 'licence.pdf',
        mimeType: 'application/pdf',
        byteSize: bytes,
        sha256: 'a'.repeat(64),
        content: Buffer.alloc(bytes, 1),
      },
    });
    // As if written `ageDays` ago, and untouched since.
    await tx.$executeRawUnsafe(
      `UPDATE coach_profile SET "updatedAt" = (now() AT TIME ZONE 'UTC') - make_interval(days => $2::int) WHERE "userId" = $1`,
      userId,
      ageDays,
    );
    await tx.$executeRawUnsafe(
      `UPDATE coach_certificate SET "uploadedAt" = now() - make_interval(days => $2::int) WHERE "userId" = $1`,
      userId,
      ageDays,
    );
  });
  return userId;
}

const remaining = () =>
  asAppSuperuser(db, (tx) =>
    tx.coachCertificate.findMany({ select: { userId: true }, orderBy: { userId: 'asc' } }),
  ).then((rows) => rows.map((r) => r.userId).sort());

beforeEach(() => resetDatabase(db));

it('deletes a draft’s and a declined profile’s certificate after 30 untouched days, and keeps the rest', async () => {
  expect(DRAFT_CERTIFICATE_KEPT_DAYS).toBe(30);
  const oldDraft = await coachWith('DRAFT', 31);
  const oldDeclined = await coachWith('DECLINED', 40);
  const orphan = await coachWith(null, 31);
  const freshDraft = await coachWith('DRAFT', 29, 2000);
  const waiting = await coachWith('SUBMITTED', 60, 3000);
  const approved = await coachWith('APPROVED', 400, 4000);

  const result = await sweepStaleCertificates();
  expect(result).toEqual({ deleted: 3, stored: 3, storedBytes: 9000 });
  expect(await remaining()).toEqual([freshDraft, waiting, approved].sort());
  // The profiles themselves stay: text and sports are not the document.
  const profiles = await asAppSuperuser(db, (tx) =>
    tx.coachProfile.count({ where: { userId: { in: [oldDraft, oldDeclined] } } }),
  );
  expect(profiles).toBe(2);
  expect(orphan).toBeTruthy();

  // Nothing more to do the next day.
  expect(await sweepStaleCertificates()).toEqual({ deleted: 0, stored: 3, storedBytes: 9000 });
});

it('a draft edited recently keeps an old certificate: "no change" is the profile’s', async () => {
  const userId = await coachWith('DRAFT', 45);
  await asAppSuperuser(db, (tx) =>
    tx.$executeRawUnsafe(
      `UPDATE coach_profile SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '2 days' WHERE "userId" = $1`,
      userId,
    ),
  );
  expect((await sweepStaleCertificates()).deleted).toBe(0);
  expect(await remaining()).toEqual([userId]);
});

it('runs with the daily media sweep, which says what it did, storage or not', async () => {
  const before = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-test-secret-0123456789'; // pragma: allowlist secret
  try {
    await coachWith('DRAFT', 31, 500);
    await coachWith('APPROVED', 31, 700);
    const res = await sweepRoute(
      new NextRequest('http://t/api/cron/sweep-orphan-media', {
        method: 'POST',
        headers: { 'x-cron-secret': 'cron-test-secret-0123456789' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      certificates: { deleted: 1, stored: 1, storedBytes: 700 },
    });
  } finally {
    if (before === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = before;
  }
});
