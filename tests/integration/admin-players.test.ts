import { listPlayers } from '@/app-layer/repositories/player';
import {
  adjustPlayerCredit,
  CreditAdjustmentTooLargeError,
  MAX_CREDIT_ADJUSTMENT_CENTS,
  PlayerNotAtThisClubError,
  setPlayerTags,
} from '@/app-layer/usecases/players';
import { getBalance } from '@/app-layer/usecases/wallet';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE PLAYERS SCREEN'S DATA, AND THE LEDGER BENEATH IT.
 *
 * Two things here are easy to get wrong in ways that do not raise:
 *
 *   the RLS-crossing join   app_user has NO row security. Starting from users
 *                           instead of relationships is one forgotten `where`
 *                           from being a cross-club directory.
 *
 *   the ledger isolation    appendEntry refuses to run outside SERIALIZABLE,
 *                           and isolation can only be set on the OUTERMOST
 *                           BEGIN — which runInTenantContext owns.
 */

describe('admin players', () => {
  const db = prismaTestClient();

  /** A player at a club: a global user plus a relationship to that club. */
  async function player(tenantId: string, tag: string, over: { tags?: string[] } = {}) {
    const user = await asAppSuperuser(db, (tx) =>
      tx.user.create({
        data: { email: `${tag}-${tenantId.slice(-6)}@test.invalid`, name: `Player ${tag}` },
        select: { id: true, email: true },
      }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.create({
        data: { tenantId, playerUserId: user.id, tags: over.tags ?? [] },
      }),
    );
    return user;
  }

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: lists this club’s players and not another club’s, across the RLS boundary', async () => {
    // `player_venue_relationship` is tenant-scoped; `app_user` is global with
    // no policy at all. The query must start from the relationships, so the
    // set of users is already the answer.
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    await player(mine.tenantId, 'mine-a');
    await player(mine.tenantId, 'mine-b');
    await player(theirs.tenantId, 'theirs');

    const rows = await runInTenantContext(mine.tenantId, (c) => listPlayers(c, mine.tenantId));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.email.includes('mine-'))).toBe(true);
    // The join resolved — a blank email would mean the user lookup silently
    // returned nothing and the screen would render empty rows.
    expect(rows.every((r) => r.email.length > 0)).toBe(true);
  });

  it('reports credit as the sum of deltas, agreeing with wallet.getBalance', async () => {
    // ═══ THE INVARIANT THE LIST DEPENDS ON ═══
    //
    // The list sums deltaCents in one grouped query; getBalance reads the
    // latest running total. They must agree, or the list and the detail show
    // different numbers for the same player and nobody knows which to trust.
    const t = await seedTenant({}, db);
    const p = await player(t.tenantId, 'rich');

    for (const delta of [1000, -250, 500]) {
      await runInTenantContext(
        t.tenantId,
        (c) =>
          adjustPlayerCredit(c, t.tenantId, t.userId, {
            playerUserId: p.id,
            deltaCents: delta,
            note: 'test adjustment for the invariant',
          }),
        undefined,
        { isolationLevel: 'Serializable' },
      );
    }

    const rows = await runInTenantContext(t.tenantId, (c) => listPlayers(c, t.tenantId));
    const running = await runInTenantContext(t.tenantId, (c) =>
      getBalance(c, { tenantId: t.tenantId, userId: p.id }),
    );

    expect(rows[0]!.creditCents).toBe(1250);
    expect(rows[0]!.creditCents).toBe(running);
  });

  it('REFUSES a credit adjustment outside a SERIALIZABLE transaction', async () => {
    // The trap this use case documents. Without the isolation option the
    // request is silently dropped to a SAVEPOINT, two concurrent appends read
    // the same balance, and the ledger stops agreeing with itself — so
    // appendEntry checks what it actually got.
    const t = await seedTenant({}, db);
    const p = await player(t.tenantId, 'p');

    await expect(
      runInTenantContext(t.tenantId, (c) =>
        adjustPlayerCredit(c, t.tenantId, t.userId, {
          playerUserId: p.id,
          deltaCents: 500,
          note: 'no isolation requested',
        }),
      ),
    ).rejects.toThrow(/isolation/i);
  });

  it('caps a single hand-typed adjustment', async () => {
    // The field takes euros. A slipped decimal turns 5.00 into 500.00, and the
    // ledger is append-only — the correction is another row and the wrong
    // number stays visible for ever.
    const t = await seedTenant({}, db);
    const p = await player(t.tenantId, 'p');

    await expect(
      runInTenantContext(
        t.tenantId,
        (c) =>
          adjustPlayerCredit(c, t.tenantId, t.userId, {
            playerUserId: p.id,
            deltaCents: MAX_CREDIT_ADJUSTMENT_CENTS + 1,
            note: 'slipped a decimal',
          }),
        undefined,
        { isolationLevel: 'Serializable' },
      ),
    ).rejects.toThrow(CreditAdjustmentTooLargeError);

    // And nothing was written.
    const rows = await runInTenantContext(t.tenantId, (c) => listPlayers(c, t.tenantId));
    expect(rows[0]!.creditCents).toBe(0);
  });

  it('cannot touch a player who does not play at this club', async () => {
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const theirPlayer = await player(theirs.tenantId, 'theirs');

    await expect(
      runInTenantContext(mine.tenantId, (c) =>
        setPlayerTags(c, mine.tenantId, mine.userId, theirPlayer.id, ['vip']),
      ),
    ).rejects.toThrow(PlayerNotAtThisClubError);

    await expect(
      runInTenantContext(
        mine.tenantId,
        (c) =>
          adjustPlayerCredit(c, mine.tenantId, mine.userId, {
            playerUserId: theirPlayer.id,
            deltaCents: 1000,
            note: 'reaching into another club',
          }),
        undefined,
        { isolationLevel: 'Serializable' },
      ),
    ).rejects.toThrow(PlayerNotAtThisClubError);
  });

  it.each([
    ['an object', {} as unknown as string],
    ['undefined', undefined as unknown as string],
    ['an empty string', ''],
  ])('REFUSES %s as a player id, rather than matching every player', async (_label, bad) => {
    // ═══ THE CLUB-WIDE OVERWRITE ═══
    //
    // Prisma reads `undefined` in a where as NOT SPECIFIED. A non-string id
    // collapsed `where: { tenantId, playerUserId }` to `where: { tenantId }`,
    // so findFirst returned an arbitrary player and updateMany rewrote EVERY
    // player's tags — which also silently repriced the club, because
    // PricingConditions matches on tags.
    //
    // A Server Action's arguments are not form fields; a crafted POST supplies
    // them directly.
    const t = await seedTenant({}, db);
    const a = await player(t.tenantId, 'a', { tags: ['keep-a'] });
    const b = await player(t.tenantId, 'b', { tags: ['keep-b'] });

    await expect(
      runInTenantContext(t.tenantId, (c) => setPlayerTags(c, t.tenantId, t.userId, bad, ['vip'])),
    ).rejects.toThrow(PlayerNotAtThisClubError);

    const rows = await runInTenantContext(t.tenantId, (c) => listPlayers(c, t.tenantId));
    const tags = Object.fromEntries(rows.map((r) => [r.playerUserId, r.tags]));
    expect(tags[a.id]).toEqual(['keep-a']);
    expect(tags[b.id]).toEqual(['keep-b']);
  });

  it('a tag change touches exactly one player', async () => {
    const t = await seedTenant({}, db);
    const a = await player(t.tenantId, 'a', { tags: ['keep-a'] });
    const b = await player(t.tenantId, 'b', { tags: ['keep-b'] });

    await runInTenantContext(t.tenantId, (c) =>
      setPlayerTags(c, t.tenantId, t.userId, a.id, ['vip']),
    );

    const rows = await runInTenantContext(t.tenantId, (c) => listPlayers(c, t.tenantId));
    const tags = Object.fromEntries(rows.map((r) => [r.playerUserId, r.tags]));
    expect(tags[a.id]).toEqual(['vip']);
    expect(tags[b.id]).toEqual(['keep-b']);
  });

  it('normalises tags, because they drive pricing rules', async () => {
    // `PricingConditions.playerTags` matches on these strings. " coach" and
    // "coach" would be two different rules' worth of behaviour for what a
    // human typed as one tag.
    const t = await seedTenant({}, db);
    const p = await player(t.tenantId, 'p');

    const cleaned = await runInTenantContext(t.tenantId, (c) =>
      setPlayerTags(c, t.tenantId, t.userId, p.id, ['  coach ', 'coach', 'vip', '', '  ']),
    );

    expect(cleaned).toEqual(['coach', 'vip']);

    const rows = await runInTenantContext(t.tenantId, (c) => listPlayers(c, t.tenantId));
    expect(rows[0]!.tags).toEqual(['coach', 'vip']);
  });

  it('REFUSES a deduction that would take the balance below zero', async () => {
    // ═══ A CONSTRAINT THE SCREEN HAS TO RESPECT ═══
    //
    // `appendEntry` will not write a negative balance — "a negative balance
    // means we let someone spend credit they do not have". So an admin cannot
    // claw back credit a player never had, and the form must not offer it.
    //
    // Found by writing this test expecting the opposite: a -500 adjustment
    // from a zero balance throws InsufficientCreditError.
    const t = await seedTenant({}, db);
    const p = await player(t.tenantId, 'p');

    await expect(
      runInTenantContext(
        t.tenantId,
        (c) =>
          adjustPlayerCredit(c, t.tenantId, t.userId, {
            playerUserId: p.id,
            deltaCents: -500,
            note: 'clawing back credit that was never there',
          }),
        undefined,
        { isolationLevel: 'Serializable' },
      ),
    ).rejects.toThrow(/insufficient credit/i);

    const rows = await runInTenantContext(t.tenantId, (c) => listPlayers(c, t.tenantId));
    expect(rows[0]!.creditCents).toBe(0);
  });

  it('records the decision, not just the money', async () => {
    // CreditLedgerEntry has nowhere to put a reason — its refId holds the
    // actor, which is not an explanation.
    const t = await seedTenant({}, db);
    const p = await player(t.tenantId, 'p');

    // Credit first: a deduction below zero is refused, see above.
    await runInTenantContext(
      t.tenantId,
      (c) =>
        adjustPlayerCredit(c, t.tenantId, t.userId, {
          playerUserId: p.id,
          deltaCents: 2000,
          note: 'goodwill after a cancelled session',
        }),
      undefined,
      { isolationLevel: 'Serializable' },
    );

    await runInTenantContext(
      t.tenantId,
      (c) =>
        adjustPlayerCredit(c, t.tenantId, t.userId, {
          playerUserId: p.id,
          deltaCents: -500,
          note: 'charged twice for the 19:00 slot on Tuesday',
        }),
      undefined,
      { isolationLevel: 'Serializable' },
    );

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirst({
        where: { tenantId: t.tenantId, action: 'PLAYER_CREDIT_ADJUSTED' },
        orderBy: { createdAt: 'desc' },
        select: { actorUserId: true, details: true, detailsJson: true },
      }),
    );

    expect(audit?.actorUserId).toBe(t.userId);
    expect(audit?.details).toMatch(/charged twice/);
    const d = audit!.detailsJson as { after?: { deltaCents?: number; balanceAfterCents?: number } };
    expect(d.after?.deltaCents).toBe(-500);
    expect(d.after?.balanceAfterCents).toBe(1500);
  });

  it('searches by name and email within the club, never across it', async () => {
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    await player(mine.tenantId, 'findme');
    await player(theirs.tenantId, 'findme');

    const rows = await runInTenantContext(mine.tenantId, (c) =>
      listPlayers(c, mine.tenantId, { search: 'findme' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toContain(mine.tenantId.slice(-6));
  });
});
