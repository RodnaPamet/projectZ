import { execFileSync } from 'node:child_process';

import { prismaTestClient, resetDatabase, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * deploy/rollback/p88-park.sql leaves no bell row the pre-P88 image cannot
 * read, and p88-unpark.sql gives every one back. SPORT_FACT («Факт на седмицата»)
 * is the only new enum value; the fact is never emailed.
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

describe('rolling back past P88', () => {
  it('SPORT_FACT is the last value of NotificationKind', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ v: string }>>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'NotificationKind'
        ORDER BY e.enumsortorder DESC LIMIT 1`,
    );
    expect(rows.map((r) => r.v)).toEqual(['SPORT_FACT']);
  });

  it('parks every fact row and gives each back as it was', async () => {
    const userId = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) =>
      tx.notification.createMany({
        data: [
          {
            userId,
            kind: 'SPORT_FACT',
            title: 'Факт на седмицата · Тенис',
            body: 'b',
            dedupeKey: 'sport-fact:2026-W46',
            readAt: new Date(),
          },
          { userId, kind: 'SPORT_FACT', title: 'a', body: 'b', dedupeKey: 'sport-fact:2026-W47' },
          // A kind the previous image knows stays where it is.
          { userId, kind: 'BOOKING_CONFIRMED', title: 'a', body: 'b', dedupeKey: 'x1' },
        ],
      }),
    );
    const kinds = () =>
      db.$queryRawUnsafe<Array<{ k: string; d: string }>>(
        `SELECT "kind"::text AS k, "dedupeKey" AS d FROM "notification" ORDER BY "dedupeKey"`,
      );

    // Twice: a park that is run again must not lose or double anything.
    run('deploy/rollback/p88-park.sql');
    run('deploy/rollback/p88-park.sql');
    expect(await kinds()).toEqual([{ k: 'BOOKING_CONFIRMED', d: 'x1' }]);

    run('deploy/rollback/p88-unpark.sql');
    expect(await kinds()).toEqual([
      { k: 'SPORT_FACT', d: 'sport-fact:2026-W46' },
      { k: 'SPORT_FACT', d: 'sport-fact:2026-W47' },
      { k: 'BOOKING_CONFIRMED', d: 'x1' },
    ]);
    const read = await asAppSuperuser(db, (tx) =>
      tx.notification.findFirstOrThrow({ where: { userId, dedupeKey: 'sport-fact:2026-W46' } }),
    );
    expect(read.readAt).not.toBeNull();
    const left = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'p88_parked_notification'`,
    );
    expect(Number(left[0]!.n)).toBe(0);
  });

  it('a week sent again while parked keeps the new row, and unparking does not fail', async () => {
    const userId = await seedAccount('PLAYER', db);
    const fact = (body: string) =>
      asAppSuperuser(db, (tx) =>
        tx.notification.create({
          data: {
            userId,
            kind: 'SPORT_FACT',
            title: 't',
            body,
            dedupeKey: 'sport-fact:2026-W47',
          },
        }),
      );
    await fact('old');
    run('deploy/rollback/p88-park.sql');
    await fact('new');
    run('deploy/rollback/p88-unpark.sql');
    const rows = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId }, select: { body: true } }),
    );
    expect(rows).toEqual([{ body: 'new' }]);
  });

  it('unparking with nothing parked is harmless', async () => {
    run('deploy/rollback/p88-unpark.sql');
    expect(await asAppSuperuser(db, (tx) => tx.notification.count())).toBe(0);
  });
});
