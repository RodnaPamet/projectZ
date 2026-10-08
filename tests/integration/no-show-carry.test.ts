import { NextRequest } from 'next/server';

import { DELETE as deleteMe } from '@/app/api/v1/me/route';
import { listPlayers } from '@/app-layer/repositories/player';
import {
  assertMayBookOnline,
  clearNoShowBlock,
  noShowStanding,
  noShowStandings,
} from '@/app-layer/usecases/booking-rules';
import { purgeLapsedNoShowCarries } from '@/app-layer/usecases/no-show-carry';
import { authOptions } from '@/auth';
import { noShowFingerprint } from '@/lib/account/no-show-fingerprint';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * A deleted account's no-show standing carries to the next account made with
 * the same address (#370 review; owner decision 2026-10-08: "carry the no-show
 * block over"). Against a real database: what is kept and what is not, the
 * new account blocked where the old one was, the club seeing it and lifting
 * it, every carried no-show lapsing when it would have, and a second deletion
 * carrying it on.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function callDelete(who: TestIdentity) {
  const res = await deleteMe(
    new NextRequest('http://localhost:3000/api/v1/me', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${who.bearer}` },
    }),
    {},
  );
  return res.status;
}

/** A first Google sign-in with this address: what makes the new account. */
async function signInAgain(email: string): Promise<string> {
  const user = { id: `google-${Math.random()}`, email, name: 'Наново', image: null };
  const ok = await authOptions.callbacks!.signIn!({
    user,
    account: { type: 'oauth', provider: 'google', providerAccountId: user.id },
    profile: { email_verified: true },
  } as never);
  expect(ok).toBe(true);
  return user.id;
}

const carries = () =>
  asAppSuperuser(db, (tx) =>
    tx.noShowCarry.findMany({
      select: {
        tenantId: true,
        fingerprint: true,
        deletedUserId: true,
        inheritedByUserId: true,
        startedAt: true,
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
  );

describe('a no-show standing carried over a deletion (#370 review, P53)', () => {
  let clubA: SeededTenant;
  let clubB: SeededTenant;
  let courtA: { venueId: string; venueSlug: string; resourceId: string };
  let player: TestIdentity;
  let email: string;

  /** A missed booking `daysAgo` days ago at club A, booked by `userId`. */
  const noShow = (userId: string, daysAgo: number) =>
    asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: clubA.tenantId,
          resourceId: courtA.resourceId,
          startTs: new Date(Date.now() - daysAgo * DAY),
          endTs: new Date(Date.now() - daysAgo * DAY + HOUR),
          bookedByUserId: userId,
          totalCents: 2400,
          status: 'NO_SHOW',
          idempotencyKey: `noshow-${Math.random()}`,
        },
      }),
    );

  beforeEach(async () => {
    clubA = await seedTenant({ name: 'Клуб Алфа' });
    clubB = await seedTenant({ name: 'Клуб Бета' });
    courtA = await seedVenue(clubA.tenantId);
    await seedVenue(clubB.tenantId);
    player = await signInAs(db, {
      userId: await seedPlayer(db, clubA.tenantId, 'carried'),
      memberships: [],
    });
    email = (
      await asAppSuperuser(db, (tx) =>
        tx.user.findUniqueOrThrow({ where: { id: player.userId }, select: { email: true } }),
      )
    ).email;
  });

  it('three that count: kept against the fingerprint, and the next account is blocked there too', async () => {
    for (const days of [10, 20, 30]) await noShow(player.userId, days);
    await noShow(player.userId, 120); // long lapsed: not carried
    await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.create({
        data: {
          tenantId: clubA.tenantId,
          playerUserId: player.userId,
          noShowCount: 4,
          tags: ['вип'],
        },
      }),
    );
    expect(
      await asAppUser(db, clubA.tenantId, (tx) =>
        noShowStanding(tx, clubA.tenantId, player.userId),
      ),
    ).toMatchObject({ recentNoShows: 3, blocked: true });

    expect(await callDelete(player)).toBe(204);

    const kept = await carries();
    expect(kept).toHaveLength(3);
    for (const row of kept) {
      expect(row).toMatchObject({
        tenantId: clubA.tenantId,
        fingerprint: noShowFingerprint(email),
        deletedUserId: player.userId,
        inheritedByUserId: null,
      });
    }
    // No name, no address: only the keyed fingerprint.
    expect(JSON.stringify(kept)).not.toContain(email);

    const fresh = await signInAgain(email.toUpperCase());
    expect(fresh).not.toBe(player.userId);
    expect((await carries()).every((c) => c.inheritedByUserId === fresh)).toBe(true);

    // Club A: blocked, as the deleted account was.
    const standing = await asAppUser(db, clubA.tenantId, (tx) =>
      noShowStanding(tx, clubA.tenantId, fresh),
    );
    expect(standing).toMatchObject({ recentNoShows: 3, blocked: true });
    await expect(
      asAppUser(db, clubA.tenantId, (tx) => assertMayBookOnline(tx, clubA.tenantId, fresh)),
    ).rejects.toMatchObject({ name: 'NoShowBlockedError', recentNoShows: 3 });

    // And the club sees the new account on its players screen, blocked; the
    // tags stayed behind.
    const board = await asAppUser(db, clubA.tenantId, async (tx) => {
      const players = await listPlayers(tx, clubA.tenantId);
      return { players, standings: await noShowStandings(tx, clubA.tenantId, players) };
    });
    const row = board.players.find((p) => p.playerUserId === fresh);
    expect(row).toMatchObject({ noShowCount: 3, tags: [] });
    expect(board.standings.get(fresh)).toMatchObject({ recentNoShows: 3, blocked: true });

    // Club B never had a standing: nothing there.
    expect(
      await asAppUser(db, clubB.tenantId, (tx) => noShowStanding(tx, clubB.tenantId, fresh)),
    ).toMatchObject({ recentNoShows: 0, blocked: false });

    // A second sign-in takes over nothing twice.
    await signInAgain(email);
    expect(
      await asAppUser(db, clubA.tenantId, (tx) => noShowStanding(tx, clubA.tenantId, fresh)),
    ).toMatchObject({ recentNoShows: 3 });
  });

  it('the club lifts the new account’s block as it would anybody’s', async () => {
    for (const days of [5, 6, 7]) await noShow(player.userId, days);
    expect(await callDelete(player)).toBe(204);
    const fresh = await signInAgain(email);

    await asAppUser(db, clubA.tenantId, (tx) =>
      clearNoShowBlock(tx, clubA.tenantId, { playerUserId: fresh, actorUserId: clubA.userId }),
    );
    expect(
      await asAppUser(db, clubA.tenantId, (tx) => noShowStanding(tx, clubA.tenantId, fresh)),
    ).toMatchObject({ recentNoShows: 0, blocked: false });
  });

  it('nothing that counts, nothing kept: no row and no fingerprint', async () => {
    await noShow(player.userId, 100);
    expect(await callDelete(player)).toBe(204);
    expect(await carries()).toEqual([]);
  });

  it('a block the club had lifted before the deletion stays lifted', async () => {
    for (const days of [3, 4, 5]) await noShow(player.userId, days);
    await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.create({
        data: {
          tenantId: clubA.tenantId,
          playerUserId: player.userId,
          noShowCount: 3,
          noShowBlockClearedAt: new Date(Date.now() - DAY),
        },
      }),
    );
    expect(await callDelete(player)).toBe(204);
    expect(await carries()).toEqual([]);
  });

  it('each lapses when it would have, and the completion sweep drops it', async () => {
    for (const days of [10, 20, 30]) await noShow(player.userId, days);
    expect(await callDelete(player)).toBe(204);
    expect(await carries()).toHaveLength(3);

    // 75 days on, the ones from 20 and 30 days ago are past their 90.
    const later = new Date(Date.now() + 75 * DAY);
    expect(await asAppSuperuser(db, (tx) => purgeLapsedNoShowCarries(tx, later))).toBe(2);
    expect(await carries()).toHaveLength(1);
    // And the last one ten days after that.
    const last = new Date(Date.now() + 85 * DAY);
    expect(await asAppSuperuser(db, (tx) => purgeLapsedNoShowCarries(tx, last))).toBe(1);
    expect(await carries()).toEqual([]);
  });

  it('the account that took it over, deleted in turn, carries it on under its own tombstone', async () => {
    for (const days of [10, 20, 30]) await noShow(player.userId, days);
    expect(await callDelete(player)).toBe(204);
    const second = await signInAs(db, { userId: await signInAgain(email), memberships: [] });
    // Its own no-show too.
    await noShow(second.userId, 2);

    expect(await callDelete(second)).toBe(204);

    const kept = await carries();
    expect(kept).toHaveLength(4);
    expect(
      kept.every((c) => c.deletedUserId === second.userId && c.inheritedByUserId === null),
    ).toBe(true);

    // A third account with the address is blocked again, by all four.
    const third = await signInAgain(email);
    expect(
      await asAppUser(db, clubA.tenantId, (tx) => noShowStanding(tx, clubA.tenantId, third)),
    ).toMatchObject({ recentNoShows: 4, blocked: true });
  });
});
