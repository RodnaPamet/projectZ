import { execFileSync } from 'node:child_process';

import { prismaTestClient, resetDatabase, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * deploy/rollback/p79-park.sql leaves no bell row and no queued or sent email
 * the pre-P79 image cannot read, and p79-unpark.sql gives every one back
 * (#575). The three RESULT_ kinds of "NotificationKind" are the only new enum
 * values.
 */

const db = prismaTestClient();

const NEW_KINDS = ['RESULT_REPORTED', 'RESULT_DISPUTED', 'RESULT_DECIDED'] as const;

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeEach(async () => {
  await resetDatabase(db);
});

describe('rolling back past P79', () => {
  it('the three kinds are exactly what the migration added', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ v: string }>>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'NotificationKind'
          AND e.enumlabel LIKE 'RESULT\\_%'
        ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.v)).toEqual([...NEW_KINDS]);
  });

  it('parks every bell row and every queued or sent email of the new kinds, and gives each back', async () => {
    const userId = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, async (tx) => {
      await tx.notification.createMany({
        data: [
          ...NEW_KINDS.map((kind, i) => ({
            userId,
            kind,
            title: 'a',
            body: 'b',
            dedupeKey: `k${i}`,
            ...(i === 1 ? { readAt: new Date() } : {}),
          })),
          // Kinds the previous image knows stay where they are.
          { userId, kind: 'BOOKING_CONFIRMED' as const, title: 'a', body: 'b', dedupeKey: 'x1' },
          {
            userId,
            kind: 'COACH_PROFILE_APPROVED' as const,
            title: 'a',
            body: 'b',
            dedupeKey: 'x2',
          },
        ],
      });
      await tx.emailOutbox.createMany({
        data: [
          {
            userId,
            kind: 'RESULT_REPORTED',
            category: 'confirmation',
            dedupeKey: 'e1',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
          {
            userId,
            kind: 'RESULT_DECIDED',
            category: 'confirmation',
            dedupeKey: 'e2',
            locale: 'bg',
            subject: 's',
            text: 't',
            status: 'SENT',
            sentAt: new Date(),
          },
          {
            userId,
            kind: 'BOOKING_CONFIRMED',
            category: 'confirmation',
            dedupeKey: 'e3',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
        ],
      });
    });
    const kinds = () =>
      db.$queryRawUnsafe<Array<{ k: string }>>(
        `SELECT "kind"::text AS k FROM "notification" ORDER BY "dedupeKey"`,
      );
    const emails = () =>
      db.$queryRawUnsafe<Array<{ k: string; s: string }>>(
        `SELECT "kind"::text AS k, "status"::text AS s FROM "email_outbox" ORDER BY "dedupeKey"`,
      );

    // Twice: a park that is run again must not lose or double anything.
    run('deploy/rollback/p79-park.sql');
    run('deploy/rollback/p79-park.sql');
    expect((await kinds()).map((r) => r.k)).toEqual([
      'BOOKING_CONFIRMED',
      'COACH_PROFILE_APPROVED',
    ]);
    expect(await emails()).toEqual([{ k: 'BOOKING_CONFIRMED', s: 'PENDING' }]);

    run('deploy/rollback/p79-unpark.sql');
    expect((await kinds()).map((r) => r.k)).toEqual([
      ...NEW_KINDS,
      'BOOKING_CONFIRMED',
      'COACH_PROFILE_APPROVED',
    ]);
    expect(await emails()).toEqual([
      { k: 'RESULT_REPORTED', s: 'PENDING' },
      { k: 'RESULT_DECIDED', s: 'SENT' },
      { k: 'BOOKING_CONFIRMED', s: 'PENDING' },
    ]);
    // What a row was is kept: the one that had been read is still read.
    const read = await asAppSuperuser(db, (tx) =>
      tx.notification.findFirstOrThrow({ where: { userId, dedupeKey: 'k1' } }),
    );
    expect(read.readAt).not.toBeNull();
    // The park tables are gone: nothing is left lying about.
    const left = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE 'p79\\_parked\\_%'`,
    );
    expect(Number(left[0]!.n)).toBe(0);
  });

  it('unparking with nothing parked is harmless', async () => {
    run('deploy/rollback/p79-unpark.sql');
    expect(await asAppSuperuser(db, (tx) => tx.notification.count())).toBe(0);
  });
});
