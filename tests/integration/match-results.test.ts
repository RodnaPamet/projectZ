import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { deleteAccount } from '@/app-layer/usecases/account-deletion';
import { confirmDueResults, reportResult } from '@/app-layer/usecases/match-results';
import {
  GET as clubBookingRoute,
  POST as enterRoute,
} from '@/app/api/v1/t/[slug]/admin/bookings/[id]/result/route';
import { POST as decideRoute } from '@/app/api/v1/t/[slug]/admin/results/[id]/decide/route';
import { GET as clubListRoute } from '@/app/api/v1/t/[slug]/admin/results/route';
import { POST as confirmRoute } from '@/app/api/v1/me/results/[id]/confirm/route';
import { POST as rejectRoute } from '@/app/api/v1/me/results/[id]/reject/route';
import {
  GET as resultGetRoute,
  POST as resultPostRoute,
} from '@/app/api/v1/me/bookings/[id]/result/route';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A BOOKING'S RESULT, THROUGH THE ROUTES (#575; decisions 29–48 on #378).
 *
 * Report → the other side confirms (or 48 hours pass) → it counts, once; a
 * rejection → the club decides; the club's own entry is final. Everything is
 * real: the routes, the tenant bindings, P78/P79 and the rating engine.
 */
const HOUR = 3_600_000;

describe('a booking result', () => {
  const db: PrismaClient = prismaTestClient();

  let club: SeededTenant;
  let resourceId: string;
  let a: TestIdentity; // the booker
  let b: TestIdentity;
  let c: TestIdentity;
  let d: TestIdentity;
  let owner: TestIdentity;
  let stranger: TestIdentity;

  const playerIn = async (label: string) => {
    const id = await seedPlayer(db, club.tenantId, label);
    return signInAs(db, {
      userId: id,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  };

  beforeEach(async () => {
    club = await seedTenant({}, db);
    ({ resourceId } = await seedVenue(club.tenantId, {}, db));
    [a, b, c, d, stranger] = await Promise.all(
      ['ana', 'boris', 'cveta', 'dimo', 'stranger'].map((l) => playerIn(l)),
    );
    owner = await signInAs(db, {
      userId: club.userId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'OWNER' }],
    });
  });

  /** A padel booking of four, booked by `a`, ended `endedHoursAgo` ago. */
  async function booking(
    opts: { status?: 'COMPLETED' | 'CONFIRMED'; endedHoursAgo?: number } = {},
  ): Promise<string> {
    const end = Date.now() - (opts.endedHoursAgo ?? 2) * HOUR;
    return asAppSuperuser(db, async (tx) => {
      const row = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId,
          startTs: new Date(end - HOUR),
          endTs: new Date(end),
          status: opts.status ?? 'COMPLETED',
          totalCents: 4000,
          bookedByUserId: a.userId,
          idempotencyKey: `result-${Math.random()}`,
        },
        select: { id: true },
      });
      await tx.bookingParticipant.createMany({
        data: [b, c, d].map((p, i) => ({
          tenantId: club.tenantId,
          bookingId: row.id,
          userId: p.userId,
          position: i + 1,
        })),
      });
      return row.id;
    });
  }

  const call = async (
    route: (
      req: NextRequest,
      ctx: { params: Promise<Record<string, string>> },
    ) => Promise<Response>,
    url: string,
    who: TestIdentity,
    params: Record<string, string>,
    body?: unknown,
  ) => {
    const res = await route(
      new NextRequest(`http://t${url}`, {
        method: body === undefined && url.endsWith('/result') ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${who.bearer}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const doubles = () => ({
    sides: [
      [a.userId, b.userId],
      [c.userId, d.userId],
    ],
    score: [
      [6, 4],
      [6, 3],
    ],
  });

  const report = (bookingId: string, who: TestIdentity, body: unknown = doubles()) =>
    call(
      resultPostRoute as never,
      `/api/v1/me/bookings/${bookingId}/result`,
      who,
      { id: bookingId },
      body,
    );

  const stored = (bookingId: string) =>
    asAppSuperuser(db, (tx) => tx.matchReport.findUnique({ where: { bookingId } }));

  const ratedMatches = (bookingId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.matchResultRecord.count({ where: { dedupeKey: `booking:${bookingId}` } }),
    );

  const bellsFor = (userId: string, kind: string) =>
    asAppSuperuser(db, (tx) => tx.notification.count({ where: { userId, kind: kind as never } }));

  it('a player reports; a player on the other side confirms; it counts once and moves the ratings', async () => {
    const id = await booking();

    const before = await call(resultGetRoute as never, `/api/v1/me/bookings/${id}/result`, a, {
      id,
    });
    expect(before.body.data).toMatchObject({ canReport: true, format: 'PERIODS', result: null });
    expect(before.body.data.players).toHaveLength(4);

    const res = await report(id, a);
    expect(res.status).toBe(201);
    expect(res.body.data.result).toMatchObject({
      status: 'REPORTED',
      winnerSide: 0,
      reportedByMe: true,
    });
    // The other side is told, the reporter's own side is not.
    expect(await bellsFor(c.userId, 'RESULT_REPORTED')).toBe(1);
    expect(await bellsFor(b.userId, 'RESULT_REPORTED')).toBe(0);

    // c sees it waiting for them; b (a's partner) cannot answer it.
    const forC = await call(resultGetRoute as never, `/api/v1/me/bookings/${id}/result`, c, { id });
    expect(forC.body.data.result.canAnswer).toBe(true);
    const reportId = forC.body.data.result.id as string;
    expect(
      (
        await call(
          confirmRoute as never,
          `/api/v1/me/results/${reportId}/confirm`,
          b,
          { id: reportId },
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          confirmRoute as never,
          `/api/v1/me/results/${reportId}/confirm`,
          stranger,
          { id: reportId },
          {},
        )
      ).status,
    ).toBe(404);

    const confirmed = await call(
      confirmRoute as never,
      `/api/v1/me/results/${reportId}/confirm`,
      c,
      {
        id: reportId,
      },
      {},
    );
    expect(confirmed).toMatchObject({ status: 200, body: { data: { status: 'CONFIRMED' } } });
    expect(await ratedMatches(id)).toBe(1);
    expect((await stored(id))?.matchResultId).not.toBeNull();

    // Winners rose above where they started, losers fell.
    const mu = (userId: string) =>
      asAppSuperuser(db, (tx) =>
        tx.skillRatingHistory.findFirstOrThrow({
          where: { userId, sport: 'PADEL' },
          orderBy: { computedAt: 'desc' },
        }),
      ).then((r) => Number(r.mu));
    expect(await mu(a.userId)).toBeGreaterThan(25);
    expect(await mu(c.userId)).toBeLessThan(25);

    // Answered: a second answer, and the 48-hour sweep, change nothing.
    expect(
      (
        await call(
          confirmRoute as never,
          `/api/v1/me/results/${reportId}/confirm`,
          d,
          { id: reportId },
          {},
        )
      ).status,
    ).toBe(409);
    await confirmDueResults(new Date(Date.now() + 49 * HOUR));
    expect(await ratedMatches(id)).toBe(1);
  });

  it('a stranger cannot report it, and nobody puts a stranger on a side', async () => {
    const id = await booking();
    expect((await report(id, stranger)).status).toBe(404);
    const res = await report(id, a, { ...doubles(), sides: [[a.userId], [stranger.userId]] });
    expect(res.body.error.code).toBe('INVALID_SIDES');
    expect(await stored(id)).toBeNull();
  });

  it('refuses sides and scores that cannot be right', async () => {
    const id = await booking();
    // The reporter is not on a side.
    expect(
      (await report(id, a, { ...doubles(), sides: [[b.userId], [c.userId]] })).body.error.code,
    ).toBe('INVALID_SIDES');
    // Somebody on both sides.
    expect(
      (
        await report(id, a, {
          ...doubles(),
          sides: [
            [a.userId, b.userId],
            [b.userId, c.userId],
          ],
        })
      ).body.error.code,
    ).toBe('INVALID_SIDES');
    // Three a side in padel.
    expect(
      (await report(id, a, { ...doubles(), sides: [[a.userId, b.userId, c.userId], [d.userId]] }))
        .body.error.code,
    ).toBe('INVALID_SIDES');
    // No winner in sets.
    expect(
      (
        await report(id, a, {
          ...doubles(),
          score: [
            [6, 4],
            [4, 6],
          ],
        })
      ).body.error.code,
    ).toBe('INVALID_SCORE');
    expect(await stored(id)).toBeNull();
  });

  it('only a completed booking, within 7 days, once', async () => {
    const notDone = await booking({ status: 'CONFIRMED' });
    expect((await report(notDone, a)).body.error).toMatchObject({
      code: 'RESULT_NOT_REPORTABLE',
      details: { reason: 'not-completed' },
    });
    const old = await booking({ endedHoursAgo: 8 * 24 });
    expect((await report(old, a)).body.error).toMatchObject({
      details: { reason: 'window-passed' },
    });

    const id = await booking();
    expect((await report(id, a)).status).toBe(201);
    expect((await report(id, b)).body.error.code).toBe('RESULT_ALREADY_REPORTED');
  });

  it('nobody answers: after 48 hours it confirms itself and counts', async () => {
    const id = await booking();
    await report(id, a);
    expect(await confirmDueResults(new Date(Date.now() + 47 * HOUR))).toBe(0);
    expect(await confirmDueResults(new Date(Date.now() + 49 * HOUR))).toBe(1);
    expect((await stored(id))?.status).toBe('CONFIRMED');
    expect(await ratedMatches(id)).toBe(1);
  });

  it('a rejection goes to the club, which confirms a corrected score; the players are told', async () => {
    const id = await booking();
    await report(id, a);
    const reportId = (await stored(id))!.id;

    const rejected = await call(
      rejectRoute as never,
      `/api/v1/me/results/${reportId}/reject`,
      d,
      { id: reportId },
      {
        note: 'We won the second set 6:4',
      },
    );
    expect(rejected.body.data.status).toBe('REJECTED');
    expect((await stored(id))?.rejectNote).toBe('We won the second set 6:4');
    expect(await bellsFor(club.userId, 'RESULT_DISPUTED')).toBe(1);
    expect(await ratedMatches(id)).toBe(0);

    // The club's queue holds it.
    const queue = await call(
      clubListRoute as never,
      `/api/v1/t/${club.tenantSlug}/admin/results?status=REJECTED`,
      owner,
      { slug: club.tenantSlug },
    );
    expect(queue.body.data.items.map((r: { id: string }) => r.id)).toEqual([reportId]);

    // A player cannot decide it.
    expect(
      (
        await call(
          decideRoute as never,
          `/api/v1/t/${club.tenantSlug}/admin/results/${reportId}/decide`,
          a,
          {
            slug: club.tenantSlug,
            id: reportId,
          },
          { action: 'void' },
        )
      ).status,
    ).toBe(403);

    const decided = await call(
      decideRoute as never,
      `/api/v1/t/${club.tenantSlug}/admin/results/${reportId}/decide`,
      owner,
      { slug: club.tenantSlug, id: reportId },
      {
        action: 'confirm',
        score: [
          [6, 4],
          [4, 6],
          [3, 6],
        ],
      },
    );
    expect(decided.body.data.status).toBe('DECIDED');
    const row = await stored(id);
    expect(row).toMatchObject({ status: 'DECIDED', winnerSide: 1, decidedByUserId: club.userId });
    expect(await ratedMatches(id)).toBe(1);
    expect(await bellsFor(a.userId, 'RESULT_DECIDED')).toBe(1);
    expect(await bellsFor(d.userId, 'RESULT_DECIDED')).toBe(1);
  });

  it('a voided result counts for nothing', async () => {
    const id = await booking();
    await report(id, a);
    const reportId = (await stored(id))!.id;
    const voided = await call(
      decideRoute as never,
      `/api/v1/t/${club.tenantSlug}/admin/results/${reportId}/decide`,
      owner,
      { slug: club.tenantSlug, id: reportId },
      { action: 'void' },
    );
    expect(voided.body.data.status).toBe('VOIDED');
    expect(await ratedMatches(id)).toBe(0);
  });

  it("the club's own entry is final and counts at once", async () => {
    const id = await booking();
    const clubView = () =>
      call(
        clubBookingRoute as never,
        `/api/v1/t/${club.tenantSlug}/admin/bookings/${id}/result`,
        owner,
        { slug: club.tenantSlug, id },
      );
    expect((await clubView()).body.data).toMatchObject({
      canEnter: true,
      format: 'PERIODS',
      result: null,
    });
    expect((await clubView()).body.data.players).toHaveLength(4);
    // A player is not the club's desk.
    expect(
      (
        await call(
          clubBookingRoute as never,
          `/api/v1/t/${club.tenantSlug}/admin/bookings/${id}/result`,
          a,
          {
            slug: club.tenantSlug,
            id,
          },
        )
      ).status,
    ).toBe(403);
    const entered = await call(
      enterRoute as never,
      `/api/v1/t/${club.tenantSlug}/admin/bookings/${id}/result`,
      owner,
      { slug: club.tenantSlug, id },
      doubles(),
    );
    expect(entered.status).toBe(201);
    expect((await stored(id))?.status).toBe('DECIDED');
    expect(await ratedMatches(id)).toBe(1);
    expect((await clubView()).body.data).toMatchObject({
      canEnter: false,
      result: { status: 'DECIDED' },
    });
    // Nothing for a player to answer, or to report again.
    expect((await report(id, a)).body.error.code).toBe('RESULT_ALREADY_REPORTED');
  });

  it('a deleted account reports nothing: its session is gone, and P79 refuses the row', async () => {
    const id = await booking();
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: a.userId, by: 'self' }));
    expect((await report(id, a)).status).toBe(401);
    // Past the session, the database still refuses it.
    await expect(reportResult(a.userId, id, doubles())).rejects.toThrow(/account_deleted/);
    expect(await stored(id)).toBeNull();
  });

  it('a player who deleted the account since: shown as deleted, rated against, given no history (#582)', async () => {
    const id = await booking();
    await report(id, a);
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: d.userId, by: 'self' }));
    expect(await confirmDueResults(new Date(Date.now() + 49 * HOUR))).toBe(1);

    const history = (userId: string) =>
      asAppSuperuser(db, (tx) => tx.skillRatingHistory.count({ where: { userId } }));
    expect(await history(a.userId)).toBe(1);
    expect(await history(c.userId)).toBe(1);
    expect(await history(d.userId)).toBe(0);
    // The match is kept for the others, with the tombstone in it.
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.matchParticipant.count({
          where: { userId: d.userId, match: { dedupeKey: `booking:${id}` } },
        }),
      ),
    ).toBe(1);

    const view = await call(resultGetRoute as never, `/api/v1/me/bookings/${id}/result`, a, { id });
    expect(view.body.data.result.sides[1]).toEqual([
      { userId: c.userId, name: 'Test Player', deleted: false },
      { userId: d.userId, name: null, deleted: true },
    ]);
  });

  describe('karting: the track enters the finishing order (#577)', () => {
    /** A completed session on a track, booked by `a` with b, c and d driving too. */
    async function session(): Promise<string> {
      const end = Date.now() - 2 * HOUR;
      return asAppSuperuser(db, async (tx) => {
        const venue = await tx.resource.findUniqueOrThrow({
          where: { id: resourceId },
          select: { venueId: true },
        });
        const track = await tx.resource.create({
          data: {
            tenantId: club.tenantId,
            venueId: venue.venueId,
            name: 'Писта',
            sport: 'KARTING',
            resourceType: 'TRACK',
            surface: 'CONCRETE',
            capacity: 8,
            basePriceCents: 6000,
          },
          select: { id: true },
        });
        const row = await tx.booking.create({
          data: {
            tenantId: club.tenantId,
            resourceId: track.id,
            startTs: new Date(end - HOUR),
            endTs: new Date(end),
            status: 'COMPLETED',
            totalCents: 6000,
            bookedByUserId: a.userId,
            idempotencyKey: `race-${Math.random()}`,
          },
          select: { id: true },
        });
        await tx.bookingParticipant.createMany({
          data: [b, c, d].map((p, i) => ({
            tenantId: club.tenantId,
            bookingId: row.id,
            userId: p.userId,
            position: i + 1,
          })),
        });
        return row.id;
      });
    }

    const enter = (id: string, body: unknown, who: TestIdentity = owner) =>
      call(
        enterRoute as never,
        `/api/v1/t/${club.tenantSlug}/admin/bookings/${id}/result`,
        who,
        { slug: club.tenantSlug, id },
        body,
      );

    it('the order counts at once, as a race: first to last, each driver told their place', async () => {
      const id = await session();
      const view = await call(
        clubBookingRoute as never,
        `/api/v1/t/${club.tenantSlug}/admin/bookings/${id}/result`,
        owner,
        {
          slug: club.tenantSlug,
          id,
        },
      );
      expect(view.body.data).toMatchObject({ canEnter: true, format: 'ORDER' });

      // c won, then a, then d; b did not race.
      const res = await enter(id, { order: [c.userId, a.userId, d.userId] });
      expect(res.status).toBe(201);
      const row = await stored(id);
      expect(row).toMatchObject({
        kind: 'ORDER',
        status: 'DECIDED',
        scoreJson: null,
        winnerSide: null,
      });
      expect(row!.sidesJson).toEqual([[c.userId], [a.userId], [d.userId]]);
      expect(await ratedMatches(id)).toBe(1);

      const ranks = await asAppSuperuser(db, (tx) =>
        tx.matchParticipant.findMany({
          where: { match: { dedupeKey: `booking:${id}` } },
          select: { userId: true, rank: true, outcome: true },
          orderBy: { rank: 'asc' },
        }),
      );
      expect(ranks.map((r) => [r.userId, r.rank])).toEqual([
        [c.userId, 1],
        [a.userId, 2],
        [d.userId, 3],
      ]);
      const mu = (userId: string) =>
        asAppSuperuser(db, (tx) =>
          tx.skillRatingHistory.findFirstOrThrow({
            where: { userId, sport: 'KARTING' },
            orderBy: { computedAt: 'desc' },
          }),
        ).then((r) => Number(r.mu));
      expect(await mu(c.userId)).toBeGreaterThan(await mu(d.userId));
      // Who did not race is not rated.
      expect(
        await asAppSuperuser(db, (tx) =>
          tx.skillRatingHistory.count({ where: { userId: b.userId } }),
        ),
      ).toBe(0);

      // Each driver hears their own place; nobody confirms anything.
      const bell = (userId: string) =>
        asAppSuperuser(db, (tx) =>
          tx.notification.findFirst({ where: { userId, kind: 'RESULT_DECIDED' } }),
        );
      expect((await bell(a.userId))?.title).toMatch(/^Място 2 от 3/);
      expect(await bell(b.userId)).toBeNull();
    });

    it('a driver cannot report a race, and the track’s order must be right', async () => {
      const id = await session();
      expect((await report(id, a)).body.error).toMatchObject({
        code: 'RESULT_NOT_REPORTABLE',
        details: { reason: 'no-score' },
      });
      expect((await enter(id, { order: [a.userId] })).status).toBe(400);
      expect((await enter(id, { order: [a.userId, a.userId] })).body.error.code).toBe(
        'INVALID_ORDER',
      );
      expect((await enter(id, { order: [a.userId, stranger.userId] })).body.error.code).toBe(
        'INVALID_ORDER',
      );
      // A player is not the track's desk.
      expect((await enter(id, { order: [a.userId, b.userId] }, a)).status).toBe(403);
      expect(await stored(id)).toBeNull();
    });

    it('a match is not a race, and a race has no score', async () => {
      const padel = await booking();
      expect((await enter(padel, { order: [a.userId, b.userId] })).body.error).toMatchObject({
        details: { reason: 'not-a-race' },
      });
      const race = await session();
      expect((await enter(race, doubles())).body.error).toMatchObject({
        details: { reason: 'no-score' },
      });
    });
  });
});
