import { globSync, readFileSync } from 'node:fs';

import { deleteAccount } from '@/app-layer/usecases/account-deletion';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * EVERY `account_not_deleted` TRIGGER REFUSES A ROW FOR A DELETED ACCOUNT (#465).
 *
 * P52 gave seven tables the trigger and P64 an eighth; P69 adds the tables of
 * the modules that shipped since (messages, open play, reports, devices). The
 * list is read from the migrations themselves, so a trigger a later migration
 * adds is tested here without anybody remembering to.
 *
 * The app never reaches these: a deleted account has no session, and every
 * use case refuses it by name first. The trigger is what holds in the instant
 * a deletion commits under a request already in flight, so it is driven here
 * directly, as the database sees it.
 *
 * A BEFORE ROW trigger fires before the NOT NULL and foreign-key checks, so a
 * row holding nothing but the user column is enough to reach it: the deleted
 * account is refused by the trigger, and a live one gets past it (and is then
 * refused for being an incomplete row, which is not the trigger's business).
 */

interface Guard {
  table: string;
  column: string;
  migration: string;
}

function guards(): Guard[] {
  const out: Guard[] = [];
  const re =
    /CREATE TRIGGER\s+\w+\s+BEFORE INSERT OR UPDATE OF "(\w+)" ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION account_not_deleted\('\w+'\)/g;
  for (const file of globSync('prisma/migrations/*/migration.sql').sort()) {
    const sql = readFileSync(file.toString(), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      out.push({ table: m[2]!, column: m[1]!, migration: file.toString().split('/').at(-2)! });
    }
  }
  return out;
}

const GUARDS = guards();

describe('a deleted account gains nothing new (#465, P52 + P64 + P69)', () => {
  const db = prismaTestClient();
  let club: SeededTenant;
  let gone: string;
  let live: string;

  // Seeded per test: the suite's setup empties the database before each one.
  beforeEach(async () => {
    await resetDatabase(db);
    club = await seedTenant({}, db);
    gone = await seedPlayer(db, club.tenantId, 'gone');
    live = await seedPlayer(db, club.tenantId, 'live');
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: gone, by: 'self' }));
  });

  const insert = (g: Guard, userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(`INSERT INTO "${g.table}" ("${g.column}") VALUES ($1)`, userId),
    );

  it('the migrations were read, and P69’s tables are among them', async () => {
    expect(GUARDS.length).toBeGreaterThanOrEqual(27);
    expect(GUARDS.map((g) => `${g.table}.${g.column}`)).toEqual(
      expect.arrayContaining([
        'booking.bookedByUserId',
        'legal_acceptance.userId',
        'chat_message.senderId',
        'open_game_request.userId',
        'conversation_participant.userId',
        'user_block.blockedId',
      ]),
    );
    // The account really is a tombstone: without one, every check below
    // would pass for the wrong reason.
    const u = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: gone }, select: { deletedAt: true } }),
    );
    expect(u.deletedAt).not.toBeNull();
  });

  it('every trigger refuses the deleted account, and lets a live one past', async () => {
    const notRefused: string[] = [];
    const refusedLive: string[] = [];
    for (const g of GUARDS) {
      const key = `${g.table}.${g.column} (${g.migration})`;
      const forGone = await insert(g, gone).then(
        () => 'inserted',
        (e: unknown) => String(e),
      );
      if (!/account_deleted/.test(forGone)) notRefused.push(`${key}: ${forGone.slice(0, 160)}`);

      // A live account is not the trigger's to refuse. The bare row then fails
      // for what it lacks (a NOT NULL, a foreign key), or lands; either way the
      // trigger said nothing.
      const forLive = await insert(g, live).then(
        () => 'inserted',
        (e: unknown) => String(e),
      );
      if (/account_deleted/.test(forLive)) refusedLive.push(key);
    }
    expect(notRefused).toEqual([]);
    expect(refusedLive).toEqual([]);
  });

  it('an UPDATE that would point an existing row at the deleted account is refused too', async () => {
    const third = await seedPlayer(db, club.tenantId, 'third');
    const where = { blockerId_blockedId: { blockerId: live, blockedId: third } };
    await asAppSuperuser(db, (tx) =>
      tx.userBlock.create({ data: { blockerId: live, blockedId: third } }),
    );
    await expect(
      asAppSuperuser(db, (tx) => tx.userBlock.update({ where, data: { blockedId: gone } })),
    ).rejects.toThrow(/account_deleted/);
    await expect(
      asAppSuperuser(db, (tx) => tx.userBlock.update({ where, data: { blockerId: gone } })),
    ).rejects.toThrow(/account_deleted/);
    // And the row is as it was.
    expect(
      await asAppSuperuser(db, (tx) => tx.userBlock.findUniqueOrThrow({ where })),
    ).toMatchObject({ blockerId: live, blockedId: third });
  });

  it('clearing a reporter to NULL, as the deletion itself does, is not refused', async () => {
    const c = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.create({
        data: {
          subjectType: 'REVIEW',
          subjectId: 'r-p69',
          reason: 'user_report',
          reportedByUserId: live,
        },
        select: { id: true },
      }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.moderationCase.update({ where: { id: c.id }, data: { reportedByUserId: null } }),
    );
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.moderationCase.update({ where: { id: c.id }, data: { reportedByUserId: gone } }),
      ),
    ).rejects.toThrow(/account_deleted/);
  });
});
