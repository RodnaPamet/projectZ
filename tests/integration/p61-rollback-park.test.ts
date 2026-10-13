import { execFileSync } from 'node:child_process';

import { prismaTestClient, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * deploy/rollback/p61-park.sql leaves no bell row the pre-P61 image cannot
 * read, and p61-unpark.sql gives every one back (#376). The five OPEN_PLAY_
 * kinds of "NotificationKind" are the only new enum values.
 */

const db = prismaTestClient();

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('rolling back past P61', () => {
  it('parks every open-play bell row and gives it back', async () => {
    const userId = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) =>
      tx.notification.createMany({
        data: [
          { userId, kind: 'OPEN_PLAY_REQUESTED', title: 'a', body: 'b', dedupeKey: 'k1' },
          {
            userId,
            kind: 'OPEN_PLAY_LAPSED',
            title: 'a',
            body: 'b',
            dedupeKey: 'k2',
            readAt: new Date(),
          },
          { userId, kind: 'BOOKING_CONFIRMED', title: 'a', body: 'b', dedupeKey: 'k3' },
        ],
      }),
    );
    const kinds = () =>
      db.$queryRawUnsafe<Array<{ k: string }>>(
        `SELECT "kind"::text AS k FROM "notification" ORDER BY "dedupeKey"`,
      );

    run('deploy/rollback/p61-park.sql');
    run('deploy/rollback/p61-park.sql');
    expect((await kinds()).map((r) => r.k)).toEqual(['BOOKING_CONFIRMED']);

    run('deploy/rollback/p61-unpark.sql');
    expect((await kinds()).map((r) => r.k)).toEqual([
      'OPEN_PLAY_REQUESTED',
      'OPEN_PLAY_LAPSED',
      'BOOKING_CONFIRMED',
    ]);
    const lapsed = await asAppSuperuser(db, (tx) =>
      tx.notification.findFirstOrThrow({ where: { userId, dedupeKey: 'k2' } }),
    );
    expect(lapsed.readAt).not.toBeNull();
  });
});
