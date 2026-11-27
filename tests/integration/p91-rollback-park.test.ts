import { execFileSync } from 'node:child_process';

import { prismaTestClient, resetDatabase, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * deploy/rollback/p91-park.sql leaves no bell row or queued email the pre-P91
 * image cannot read, and p91-unpark.sql gives every one back. REVIEW_REFUSED
 * (#714, the notice about a refused review) is the only new enum value; it is
 * a bell row and an `account` email.
 */

const db = prismaTestClient();

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeEach(async () => {
  await resetDatabase(db);
});

const bell = () =>
  db.$queryRawUnsafe<Array<{ k: string; d: string }>>(
    `SELECT "kind"::text AS k, "dedupeKey" AS d FROM "notification" ORDER BY "dedupeKey"`,
  );
const outbox = () =>
  db.$queryRawUnsafe<Array<{ k: string; d: string }>>(
    `SELECT "kind"::text AS k, "dedupeKey" AS d FROM "email_outbox" ORDER BY "dedupeKey"`,
  );

describe('rolling back past P91', () => {
  it('REVIEW_REFUSED is a value of NotificationKind', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ v: string }>>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'NotificationKind' AND e.enumlabel = 'REVIEW_REFUSED'`,
    );
    expect(rows.map((r) => r.v)).toEqual(['REVIEW_REFUSED']);
  });

  it('parks every notice and its email, and gives each back as it was', async () => {
    const userId = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, async (tx) => {
      await tx.notification.createMany({
        data: [
          {
            userId,
            kind: 'REVIEW_REFUSED',
            title: 'Отзивът ви не е публикуван',
            body: 'b',
            dedupeKey: 'review-refused:r1:1',
            readAt: new Date(),
          },
          // A kind the previous image knows stays where it is.
          { userId, kind: 'BOOKING_CONFIRMED', title: 'a', body: 'b', dedupeKey: 'x1' },
        ],
      });
      await tx.emailOutbox.createMany({
        data: [
          {
            userId,
            kind: 'REVIEW_REFUSED',
            category: 'account',
            dedupeKey: 'review-refused:r1:1',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
          {
            userId,
            kind: 'BOOKING_CONFIRMED',
            category: 'confirmation',
            dedupeKey: 'x1',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
        ],
      });
    });

    // Twice: a park that is run again must not lose or double anything.
    run('deploy/rollback/p91-park.sql');
    run('deploy/rollback/p91-park.sql');
    expect(await bell()).toEqual([{ k: 'BOOKING_CONFIRMED', d: 'x1' }]);
    expect(await outbox()).toEqual([{ k: 'BOOKING_CONFIRMED', d: 'x1' }]);

    run('deploy/rollback/p91-unpark.sql');
    expect(await bell()).toEqual([
      { k: 'REVIEW_REFUSED', d: 'review-refused:r1:1' },
      { k: 'BOOKING_CONFIRMED', d: 'x1' },
    ]);
    expect(await outbox()).toEqual([
      { k: 'REVIEW_REFUSED', d: 'review-refused:r1:1' },
      { k: 'BOOKING_CONFIRMED', d: 'x1' },
    ]);
    const read = await asAppSuperuser(db, (tx) =>
      tx.notification.findFirstOrThrow({ where: { userId, dedupeKey: 'review-refused:r1:1' } }),
    );
    expect(read.readAt).not.toBeNull();
    const left = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE 'p91\\_parked\\_%'`,
    );
    expect(Number(left[0]!.n)).toBe(0);
  });

  it('unparking with nothing parked is harmless', async () => {
    run('deploy/rollback/p91-unpark.sql');
    expect(await asAppSuperuser(db, (tx) => tx.notification.count())).toBe(0);
  });
});
