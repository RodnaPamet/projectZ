import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { playerCardById } from '@/app-layer/usecases/messaging-directory';
import { listOpenGames } from '@/app-layer/usecases/open-play';
import { currentRating, recordMatch } from '@/app-layer/usecases/ratings';
import { myRatings } from '@/app-layer/usecases/shown-ratings';
import { GET as getMyRatingsRoute } from '@/app/api/v1/me/ratings/route';
import { GET as getMeRoute, PATCH as patchMeRoute } from '@/app/api/v1/me/route';
import { MODULES_OFF } from '@/components/layout/nav-items';
import { readModules } from '@/lib/modules';
import { newRating } from '@/lib/ratings/openskill';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

jest.mock('@/lib/modules', () => ({ readModules: jest.fn() }));
const modules = jest.mocked(readModules);

/**
 * WHAT A RATING SHOWS, AND TO WHOM (#576; decisions 31, 36, 47, 48).
 *
 * A player's card carries their rating beside the level they declared, while
 * the ranking module is on: provisional until five confirmed matches. A
 * player who hides it is still rated, sees it on their own page with the
 * points, and everyone else sees the declared level only.
 */
describe('a rating on the cards', () => {
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let ana: TestIdentity; // declared 6
  let boris: TestIdentity; // declared 3

  beforeEach(async () => {
    played = 0;
    modules.mockReturnValue({ ...MODULES_OFF, ranking: true });
    club = await seedTenant({}, db);
    const signIn = async (label: string, level: number) => {
      const id = await seedPlayer(db, club.tenantId, label);
      await asAppSuperuser(db, (tx) =>
        tx.playerSportLevel.create({ data: { userId: id, sport: 'PADEL', level } }),
      );
      return signInAs(db, {
        userId: id,
        memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
      });
    };
    ana = await signIn('ana', 6);
    boris = await signIn('boris', 3);
  });

  /** Ana beats Boris `n` more times. */
  let played = 0;
  const play = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await recordMatch(db, {
        tenantId: club.tenantId,
        sport: 'PADEL',
        teams: [[ana.userId], [boris.userId]],
        dedupeKey: `shown:${ana.userId}:${played++}`,
      });
    }
  };

  const anaAsSeenBy = async (viewer: string) =>
    (await playerCardById(ana.userId, viewer))!.sports.find((s) => s.sport === 'PADEL')!;

  const call = async (
    route: (req: NextRequest) => Promise<Response>,
    who: TestIdentity,
    method: 'GET' | 'PATCH',
    body?: unknown,
  ) => {
    const res = await route(
      new NextRequest('http://t/api/v1/me', {
        method,
        headers: { authorization: `Bearer ${who.bearer}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('before a match: the declared level, provisional', async () => {
    expect(await anaAsSeenBy(boris.userId)).toEqual({
      sport: 'PADEL',
      level: 6,
      rating: { level: 6, provisional: true },
    });
  });

  it('after five confirmed matches it is settled, and it moved with the results', async () => {
    await play(4);
    expect((await anaAsSeenBy(boris.userId)).rating).toMatchObject({ provisional: true });
    await play(1);
    const card = await anaAsSeenBy(boris.userId);
    expect(card.level).toBe(6); // what she declared, untouched
    expect(card.rating!.provisional).toBe(false);
    expect(card.rating!.level).toBeGreaterThan(6);
  });

  it('hidden: still rated, shown to her alone, with the points', async () => {
    await play(2);
    const off = await call(patchMeRoute as never, ana, 'PATCH', { ratingPublic: false });
    expect(off.status).toBe(200);
    expect((await call(getMeRoute as never, ana, 'GET')).body.data.ratingPublic).toBe(false);

    expect((await anaAsSeenBy(boris.userId)).rating).toBeNull();
    expect((await anaAsSeenBy(ana.userId)).rating).not.toBeNull();

    // Results still rate her.
    const before = (await currentRating(db, ana.userId, 'PADEL')).state.mu;
    await play(1);
    expect((await currentRating(db, ana.userId, 'PADEL')).state.mu).toBeGreaterThan(before);

    const page = await call(getMyRatingsRoute as never, ana, 'GET');
    expect(page.body.data.public).toBe(false);
    expect(page.body.data.items).toEqual([
      expect.objectContaining({
        sport: 'PADEL',
        provisional: true,
        matchesPlayed: 3,
        points: expect.any(Number),
      }),
    ]);
  });

  it('a player with no match yet has no points on their own page', async () => {
    expect((await myRatings(boris.userId)).items).toEqual([
      expect.objectContaining({
        sport: 'PADEL',
        level: 3,
        points: null,
        matchesPlayed: 0,
        lastPlayedAt: null,
      }),
    ]);
  });

  it('with the module off, the cards are as they were', async () => {
    await play(1);
    modules.mockReturnValue(MODULES_OFF);
    expect((await anaAsSeenBy(boris.userId)).rating).toBeNull();
  });

  it('back after a year away: the same mean, a newcomer’s uncertainty (decision 48)', async () => {
    await play(5);
    const now = await currentRating(db, ana.userId, 'PADEL');
    const later = await currentRating(
      db,
      ana.userId,
      'PADEL',
      new Date(Date.now() + 400 * 86_400_000),
    );
    expect(later.state.mu).toBe(now.state.mu);
    expect(later.engine === 'OPENSKILL' && later.state.sigma).toBeCloseTo(newRating().sigma, 5);
    expect(now.engine === 'OPENSKILL' && now.state.sigma).toBeLessThan(newRating().sigma);
  });

  it('open play hints «За вашето ниво» from the viewer’s own rating, even hidden (decision 36)', async () => {
    const { resourceId } = await seedVenue(club.tenantId, {}, db);
    const start = new Date(Date.now() + 72 * 3_600_000);
    // Boris opens a game wishing 5–7; Ana (declared 6) fits, Boris (3) not.
    const gameId = await asAppSuperuser(db, async (tx) => {
      const b = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + 3_600_000),
          bookedByUserId: boris.userId,
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `fits-${Math.random()}`,
        },
        select: { id: true },
      });
      const g = await tx.openGame.create({
        data: {
          tenantId: club.tenantId,
          bookingId: b.id,
          spotsWanted: 1,
          levelMin: 5,
          levelMax: 7,
        },
        select: { id: true },
      });
      return g.id;
    });
    const fitsFor = async (viewer: string) =>
      (await listOpenGames({}, { viewerId: viewer })).items.find((g) => g.id === gameId)?.viewer
        ?.levelFits;

    expect(await fitsFor(ana.userId)).toBe(true);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: ana.userId }, data: { ratingPublic: false } }),
    );
    expect(await fitsFor(ana.userId)).toBe(true);
    // The booker's own game: still a hint, from his own level.
    expect(await fitsFor(boris.userId)).toBe(false);

    modules.mockReturnValue(MODULES_OFF);
    expect(await fitsFor(ana.userId)).toBeNull();
  });
});
