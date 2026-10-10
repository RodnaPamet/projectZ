import { execFileSync } from 'node:child_process';

import { openClubConversation } from '@/app-layer/usecases/messaging';

import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';

/**
 * deploy/rollback/p54-park.sql leaves nothing the pre-P54 image cannot read,
 * and p54-unpark.sql gives it all back (#375). `CLUB` is the only new value.
 */

const db = prismaTestClient();

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const PRE_P54 = ['DM', 'GROUP', 'SESSION', 'VENUE_CHANNEL', 'COACH_THREAD'];

async function types(id: string): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ t: string }>>(
    `SELECT "type"::text AS t FROM "conversation" WHERE "id" = $1`,
    id,
  );
  return rows[0]!.t;
}

describe('rolling back past P54', () => {
  it('parks every CLUB conversation as a kind the old image reads, and unparks it', async () => {
    const club = await seedTenant({}, db);
    const player = await seedAccount('PLAYER', db);
    const { id } = await openClubConversation({ kind: 'player', userId: player }, club.tenantSlug);
    expect(await types(id)).toBe('CLUB');

    run('deploy/rollback/p54-park.sql');
    run('deploy/rollback/p54-park.sql');
    const left = await db.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT DISTINCT "type"::text AS t FROM "conversation"`,
    );
    expect(left.every(({ t }) => PRE_P54.includes(t))).toBe(true);

    run('deploy/rollback/p54-unpark.sql');
    expect(await types(id)).toBe('CLUB');
    // The trigger that keeps a conversation's kind fixed is back on.
    await expect(
      db.$executeRawUnsafe(`UPDATE "conversation" SET "type" = 'DM' WHERE "id" = $1`, id),
    ).rejects.toThrow(/never change/);
  });
});
