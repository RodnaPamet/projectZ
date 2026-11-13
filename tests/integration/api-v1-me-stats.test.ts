import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { recordMatch } from '@/app-layer/usecases/ratings';
import { GET as matchesRoute } from '@/app/api/v1/me/matches/route';
import { GET as statsRoute } from '@/app/api/v1/me/stats/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A PLAYER'S OWN STATISTICS (#688): `GET /me/stats` and `GET /me/matches`,
 * from counted results with scores, at a real venue.
 */
const HOUR = 3_600_000;

describe('my statistics', () => {
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let resourceId: string;
  let venueId: string;
  let a: TestIdentity;
  const ids: Record<string, string> = {};
  let n = 0;

  beforeEach(async () => {
    club = await seedTenant({}, db);
    ({ resourceId, venueId } = await seedVenue(club.tenantId, {}, db));
    for (const label of ['ana', 'boris', 'cveta', 'dimo', 'elena']) {
      ids[label] = await seedPlayer(db, club.tenantId, label);
    }
    await asAppSuperuser(db, (tx) =>
      Promise.all(
        Object.entries(ids).map(([label, id]) =>
          tx.user.update({
            where: { id },
            data: { name: label[0]!.toUpperCase() + label.slice(1) },
          }),
        ),
      ),
    );
    a = await signInAs(db, {
      userId: ids.ana!,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  });

  /**
   * A counted doubles match at the club, `hoursAgo` ago: `sides` as reported
   * (side 0 first in the score), `winner` the winning side, or null for none.
   */
  async function played(
    sides: [string[], string[]],
    score: [number, number][] | null,
    winner: 0 | 1 | null,
    hoursAgo = 2,
    sport: 'PADEL' | 'TENNIS' = 'PADEL',
  ): Promise<string> {
    const start = Date.now() - hoursAgo * HOUR;
    const bookingId = await asAppSuperuser(db, async (tx) => {
      const row = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId,
          startTs: new Date(start),
          endTs: new Date(start + HOUR),
          status: 'COMPLETED',
          totalCents: 4000,
          bookedByUserId: sides[0][0]!,
          idempotencyKey: `stats-${n++}`,
        },
        select: { id: true },
      });
      return row.id;
    });
    const teams = winner === 1 ? [sides[1], sides[0]] : [sides[0], sides[1]];
    const dedupeKey = `booking:${bookingId}`;
    await recordMatch(db, {
      tenantId: club.tenantId,
      sport,
      teams,
      ranks: winner === null ? [1, 1] : [1, 2],
      dedupeKey,
    });
    await asAppSuperuser(db, async (tx) => {
      const counted = await tx.matchResultRecord.findUniqueOrThrow({ where: { dedupeKey } });
      await tx.matchReport.create({
        data: {
          tenantId: club.tenantId,
          bookingId,
          sport,
          kind: 'SCORE',
          status: 'CONFIRMED',
          sidesJson: sides,
          scoreJson: score ?? undefined,
          winnerSide: winner,
          reportedByUserId: sides[0][0]!,
          matchResultId: counted.id,
        },
      });
    });
    return dedupeKey;
  }

  const get = async (
    route: (req: NextRequest) => Promise<Response>,
    path: string,
    who: TestIdentity | null = a,
  ) => {
    const res = await route(
      new NextRequest(`http://t/api/v1${path}`, {
        headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('is the caller’s own, signed in only; an unknown sport is a 400', async () => {
    expect((await get(statsRoute as never, '/me/stats', null)).status).toBe(401);
    expect((await get(matchesRoute as never, '/me/matches', null)).status).toBe(401);
    expect((await get(statsRoute as never, '/me/stats?sport=CURLINGX')).status).toBe(400);
    expect((await get(matchesRoute as never, '/me/matches?limit=0')).status).toBe(400);
  });

  it('a player with nothing played: no sport, an empty record', async () => {
    const res = await get(statsRoute as never, '/me/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sports: [],
      sport: null,
      rating: null,
      performance: { games: 0, wins: 0, losses: 0, draws: 0, winRate: null, currentStreak: null },
      form: [],
      sets: null,
      partners: [],
      rivals: [],
      standing: null,
      milestones: [],
    });
    expect(res.body.data.activity.months).toHaveLength(12);
  });

  it('the record, form, sets, partners, rivals and venues, from the caller’s side', async () => {
    const [ana, boris, cveta, dimo] = [ids.ana!, ids.boris!, ids.cveta!, ids.dimo!];
    // Oldest first: a win, a loss reported from the other side, two wins.
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [6, 4],
        [6, 3],
      ],
      0,
      50,
    );
    await played(
      [
        [cveta, dimo],
        [ana, boris],
      ],
      [
        [6, 4],
        [7, 5],
      ],
      0,
      40,
    );
    await played(
      [
        [ana, cveta],
        [boris, dimo],
      ],
      [
        [7, 6],
        [6, 2],
      ],
      0,
      30,
    );
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [3, 6],
        [6, 4],
        [6, 1],
      ],
      0,
      20,
    );

    const res = await get(statsRoute as never, '/me/stats');
    const s = res.body.data;
    expect(s.sports).toEqual(['PADEL']);
    expect(s.sport).toBe('PADEL');
    expect(s.performance).toEqual({
      games: 4,
      wins: 3,
      losses: 1,
      draws: 0,
      winRate: 0.75,
      currentStreak: { outcome: 'WIN', length: 2 },
      bestWinStreak: 2,
    });
    expect(s.form.map((f: { outcome: string }) => f.outcome)).toEqual([
      'WIN',
      'WIN',
      'LOSS',
      'WIN',
    ]);
    // Sets as Ana played them: 6-4 6-3 | 4-6 5-7 | 7-6 6-2 | 3-6 6-4 6-1.
    expect(s.sets).toEqual({
      scoredMatches: 4,
      setsWon: 6,
      setsLost: 3,
      gamesWon: 6 + 6 + 4 + 5 + 7 + 6 + 3 + 6 + 6,
      gamesLost: 4 + 3 + 6 + 7 + 6 + 2 + 6 + 4 + 1,
      closeSetsWon: 1,
      closeSetsLost: 1,
    });
    expect(s.partners[0]).toMatchObject({ person: { name: 'Boris' }, games: 3, wins: 2 });
    expect(s.partners[1]).toMatchObject({ person: { name: 'Cveta' }, games: 1, wins: 1 });
    expect(s.rivals.map((r: { person: { name: string } }) => r.person.name)).toEqual([
      'Dimo',
      'Cveta',
      'Boris',
    ]);
    expect(s.rivals[0]).toMatchObject({ games: 4, wins: 3 });
    expect(s.activity.venues).toEqual([
      expect.objectContaining({ id: venueId, games: 4, wins: 3, cityNames: expect.any(Object) }),
    ]);
    expect(s.activity.weekdays.reduce((x: number, y: number) => x + y, 0)).toBe(4);
    expect(s.activity.hours.reduce((x: number, y: number) => x + y, 0)).toBe(4);
    expect(s.rating.matchesRated).toBe(4);
    expect(s.rating.series).toHaveLength(4);
    expect(s.rating.provisional).toBe(true);
    expect(s.milestones.map((m: { kind: string }) => m.kind)).toEqual(
      expect.arrayContaining(['PEAK_LEVEL', 'BEST_WIN_STREAK', 'TOP_PARTNER', 'FIRST_WIN']),
    );
  });

  it('a blocked or deleted player keeps a place in a match, but no name and no row', async () => {
    const [ana, boris, cveta, dimo] = [ids.ana!, ids.boris!, ids.cveta!, ids.dimo!];
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [6, 4],
        [6, 4],
      ],
      0,
    );
    await asAppSuperuser(db, async (tx) => {
      await tx.userBlock.create({ data: { blockerId: cveta, blockedId: ana } });
      // A tombstone, as account deletion leaves one (app_user_deleted_is_scrubbed).
      await tx.user.update({
        where: { id: dimo },
        data: {
          deletedAt: new Date(),
          email: `deleted-${dimo}@deleted.playerz.invalid`,
          name: null,
        },
      });
    });
    const stats = (await get(statsRoute as never, '/me/stats')).body.data;
    expect(stats.rivals).toEqual([]);
    expect(stats.partners.map((p: { person: { name: string } }) => p.person.name)).toEqual([
      'Boris',
    ]);

    const match = (await get(matchesRoute as never, '/me/matches')).body.data.items[0];
    expect(match.opponents.map((o: { name: string | null }) => o.name)).toEqual([null, null]);
    expect(match.partners).toEqual([expect.objectContaining({ userId: boris, name: 'Boris' })]);
  });

  it('matches, newest first, a page at a time, with the level before and after', async () => {
    const [ana, boris, cveta, dimo] = [ids.ana!, ids.boris!, ids.cveta!, ids.dimo!];
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [6, 4],
        [6, 3],
      ],
      0,
      30,
    );
    await played(
      [
        [cveta, dimo],
        [ana, boris],
      ],
      [
        [6, 2],
        [6, 2],
      ],
      0,
      20,
    );
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      null,
      null,
      10,
    );

    const first = (await get(matchesRoute as never, '/me/matches?limit=2')).body.data;
    expect(first.sport).toBe('PADEL');
    expect(first.items.map((m: { outcome: string }) => m.outcome)).toEqual(['DRAW', 'LOSS']);
    expect(first.items[0].score).toBeNull();
    // Reported from the other side, read from Ana's.
    expect(first.items[1].score).toEqual([
      [2, 6],
      [2, 6],
    ]);
    expect(first.items[1].levelAfter).toBeLessThan(first.items[1].levelBefore);
    expect(first.items[1].venue).toMatchObject({ id: venueId });
    expect(first.nextCursor).toBe(first.items[1].matchId);

    const rest = (
      await get(matchesRoute as never, `/me/matches?limit=2&cursor=${first.nextCursor}`)
    ).body.data;
    expect(rest.items.map((m: { outcome: string }) => m.outcome)).toEqual(['WIN']);
    expect(rest.nextCursor).toBeNull();
    expect(
      (await get(matchesRoute as never, '/me/matches?cursor=nosuchmatch')).body.data.items,
    ).toEqual([]);
  });

  it('in the order played, though the level moved in the order the results were counted', async () => {
    const [ana, boris, cveta, dimo] = [ids.ana!, ids.boris!, ids.cveta!, ids.dimo!];
    // Counted first: a win played 10 hours ago. Counted second: a loss
    // played 50 hours ago, its result entered late.
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [6, 1],
        [6, 1],
      ],
      0,
      10,
    );
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [1, 6],
        [1, 6],
      ],
      1,
      50,
    );

    const items = (await get(matchesRoute as never, '/me/matches')).body.data.items;
    expect(items.map((m: { outcome: string }) => m.outcome)).toEqual(['WIN', 'LOSS']);
    // The win was counted first: it moved the level from where it started.
    expect(items[0].levelAfter).toBeGreaterThan(items[0].levelBefore);
    // The late loss moved it down from where the win had left it.
    expect(items[1].levelBefore).toBe(items[0].levelAfter);
    expect(items[1].levelAfter).toBeLessThan(items[1].levelBefore);

    const s = (await get(statsRoute as never, '/me/stats')).body.data;
    expect(s.form.map((f: { outcome: string }) => f.outcome)).toEqual(['WIN', 'LOSS']);
    expect(s.performance.currentStreak).toEqual({ outcome: 'WIN', length: 1 });
    expect(s.milestones.find((m: { kind: string }) => m.kind === 'FIRST_WIN').at).toBe(
      items[0].playedAt,
    );
  });

  it('the standing at the club played most at, with the rows around the caller', async () => {
    const [ana, boris, cveta, dimo] = [ids.ana!, ids.boris!, ids.cveta!, ids.dimo!];
    for (let i = 0; i < 5; i++) {
      await played(
        [
          [ana, boris],
          [cveta, dimo],
        ],
        [
          [6, 0],
          [6, 0],
        ],
        0,
        50 - i,
      );
    }
    const s = (await get(statsRoute as never, '/me/stats')).body.data;
    expect(s.standing.club).toEqual({ slug: club.tenantSlug, name: expect.any(String) });
    expect(s.standing.rank).toBe(1);
    expect(s.standing.absent).toBeNull();
    expect(s.standing.total).toBe(4);
    expect(s.standing.rows[0]).toMatchObject({ userId: ana, isYou: true, rank: 1 });
    expect(s.milestones.map((m: { kind: string }) => m.kind)).toContain('BEST_WIN_STREAK');

    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: ana }, data: { ratingPublic: false } }),
    );
    const hidden = (await get(statsRoute as never, '/me/stats')).body.data.standing;
    expect(hidden).toMatchObject({ rank: null, absent: 'HIDDEN', total: 3 });
  });

  it('one sport at a time; without one, the sport played most', async () => {
    const [ana, boris, cveta, dimo] = [ids.ana!, ids.boris!, ids.cveta!, ids.dimo!];
    await played(
      [[ana], [boris]],
      [
        [6, 1],
        [6, 1],
      ],
      0,
      30,
      'TENNIS',
    );
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [6, 1],
        [6, 1],
      ],
      0,
      20,
    );
    await played(
      [
        [ana, boris],
        [cveta, dimo],
      ],
      [
        [1, 6],
        [1, 6],
      ],
      1,
      10,
    );
    const s = (await get(statsRoute as never, '/me/stats')).body.data;
    expect(s.sports).toEqual(['TENNIS', 'PADEL']);
    expect(s.sport).toBe('PADEL');
    const tennis = (await get(statsRoute as never, '/me/stats?sport=TENNIS')).body.data;
    expect(tennis.sport).toBe('TENNIS');
    expect(tennis.performance.games).toBe(1);
    expect(tennis.partners).toEqual([]);
  });
});
