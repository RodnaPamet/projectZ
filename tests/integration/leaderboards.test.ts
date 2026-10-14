import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { recordMatch } from '@/app-layer/usecases/ratings';
import { GET as leaderboardRoute } from '@/app/api/v1/clubs/[slug]/leaderboard/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A CLUB'S LEADERBOARD (#578; decisions 35, 36, 47, 49).
 *
 * The club's players by level in a sport: settled levels only (5 confirmed
 * matches), nobody who hides theirs, nobody in a block with the viewer, and
 * only results at this club make someone its player. Signed in only.
 */
describe('a club leaderboard', () => {
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let other: SeededTenant;
  let viewer: TestIdentity;
  const ids: Record<string, string> = {};
  let n = 0;

  const match = (
    tenantId: string,
    winner: string,
    loser: string,
    sport: 'PADEL' | 'TENNIS' = 'PADEL',
  ) => recordMatch(db, { tenantId, sport, teams: [[winner], [loser]], dedupeKey: `lb:${n++}` });

  beforeEach(async () => {
    club = await seedTenant({}, db);
    other = await seedTenant({}, db);
    for (const label of ['ana', 'boris', 'cveta', 'dimo', 'elena', 'filip']) {
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
    viewer = await signInAs(db, {
      userId: await seedPlayer(db, club.tenantId, 'viewer'),
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  });

  const board = async (who: TestIdentity | null, slug = club.tenantSlug, sport?: string) => {
    const res = await leaderboardRoute(
      new NextRequest(
        `http://t/api/v1/clubs/${slug}/leaderboard${sport ? `?sport=${sport}` : ''}`,
        {
          headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
        },
      ),
      { params: Promise.resolve({ slug }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('ranks the settled players by level, and leaves out the provisional, the hidden and the blocked', async () => {
    // Ana beats Boris five times: both settled, Ana above.
    for (let i = 0; i < 5; i++) await match(club.tenantId, ids.ana!, ids.boris!);
    // Cveta has two: provisional, not listed.
    for (let i = 0; i < 2; i++) await match(club.tenantId, ids.cveta!, ids.boris!);
    // Dimo has five but hides his level.
    for (let i = 0; i < 5; i++) await match(club.tenantId, ids.dimo!, ids.elena!);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: ids.dimo! }, data: { ratingPublic: false } }),
    );
    // Elena has five too, and blocked the viewer.
    await asAppSuperuser(db, (tx) =>
      tx.userBlock.create({ data: { blockerId: ids.elena!, blockedId: viewer.userId } }),
    );

    const res = await board(viewer);
    expect(res.status).toBe(200);
    expect(res.body.data.sports).toEqual(['PADEL']);
    expect(res.body.data.sport).toBe('PADEL');
    const rows = res.body.data.rows as Array<{
      rank: number;
      userId: string;
      name: string;
      level: number;
      matchesPlayed: number;
    }>;
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Boris']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]!.level).toBeGreaterThan(rows[1]!.level);
    expect(rows[1]!.matchesPlayed).toBe(7);
  });

  it('only results at this club make someone its player', async () => {
    for (let i = 0; i < 5; i++) await match(other.tenantId, ids.filip!, ids.ana!);
    const res = await board(viewer);
    expect(res.body.data).toEqual({ sports: [], sport: null, rows: [] });
  });

  it('one sport at a time: the asked one, else the first in the enum’s order', async () => {
    for (let i = 0; i < 5; i++) await match(club.tenantId, ids.ana!, ids.boris!, 'TENNIS');
    for (let i = 0; i < 5; i++) await match(club.tenantId, ids.cveta!, ids.dimo!, 'PADEL');
    // The SportType enum lists tennis before padel.
    expect((await board(viewer)).body.data).toMatchObject({
      sports: ['TENNIS', 'PADEL'],
      sport: 'TENNIS',
    });
    const padel = await board(viewer, club.tenantSlug, 'PADEL');
    expect(padel.body.data.sport).toBe('PADEL');
    expect(padel.body.data.rows.map((r: { name: string }) => r.name)).toEqual(['Cveta', 'Dimo']);
  });

  it('signed in only (decision 49); an unknown sport is a 400; a club that is not public, a 404', async () => {
    expect((await board(null)).status).toBe(401);
    expect((await board(viewer, club.tenantSlug, 'NOT_A_SPORT')).status).toBe(400);
    expect((await board(viewer, 'no-such-club-anywhere')).status).toBe(404);
  });
});
