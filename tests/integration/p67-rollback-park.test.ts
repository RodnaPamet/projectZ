import { execFileSync } from 'node:child_process';

import { prismaTestClient } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * deploy/rollback/p67-park.sql leaves no OPEN_GAME_NOTE report or case for the
 * pre-P67 image to choke on, and p67-unpark.sql gives them back (#526).
 */

const db = prismaTestClient();

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const subjects = () =>
  db.$queryRawUnsafe<Array<{ t: string; n: number }>>(
    `SELECT "subjectType"::text AS t, count(*)::int AS n FROM "moderation_case" GROUP BY 1
     UNION ALL
     SELECT 'report:' || "subjectType"::text, count(*)::int FROM "content_report" GROUP BY 1
     ORDER BY 1`,
  );

describe('rolling back past P67', () => {
  it('parks every OPEN_GAME_NOTE case and report, and unparks them whole', async () => {
    await asAppSuperuser(db, async (tx) => {
      await tx.moderationCase.createMany({
        data: [
          { subjectType: 'OPEN_GAME_NOTE', subjectId: 'g1', reason: 'user_report' },
          { subjectType: 'CONVERSATION', subjectId: 'cv1', reason: 'user_report' },
          { subjectType: 'CHAT_MESSAGE', subjectId: 'm1', reason: 'user_report' },
        ],
      });
      await tx.contentReport.create({
        data: {
          subjectType: 'OPEN_GAME_NOTE',
          subjectId: 'g1',
          reporterUserId: 'u1',
          reason: 'spam',
        },
      });
    });
    const before = await subjects();

    run('deploy/rollback/p67-park.sql');
    run('deploy/rollback/p67-park.sql');
    // The other subjects are left exactly where they were.
    expect((await subjects()).map((r) => r.t)).toEqual(['CHAT_MESSAGE', 'CONVERSATION']);

    run('deploy/rollback/p67-unpark.sql');
    expect(await subjects()).toEqual(before);
  });
});
