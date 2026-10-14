import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { DELETE as leaveRoute } from '@/app/api/v1/me/bookings/[id]/participation/route';
import { POST as answerConfirmRoute } from '@/app/api/v1/me/results/[id]/confirm/route';
import { POST as reportRoute } from '@/app/api/v1/me/bookings/[id]/result/route';
import { POST as confirmEntryRoute } from '@/app/api/v1/t/[slug]/admin/tournament-entries/[id]/confirm/route';
import { POST as scheduleRoute } from '@/app/api/v1/t/[slug]/admin/tournament-matches/[id]/schedule/route';
import { POST as walkoverRoute } from '@/app/api/v1/t/[slug]/admin/tournament-matches/[id]/walkover/route';
import {
  DELETE as letGoRoute,
  POST as proposeRoute,
} from '@/app/api/v1/me/tournament-matches/[id]/proposal/route';
import { POST as acceptRoute } from '@/app/api/v1/me/tournament-matches/[id]/proposal/accept/route';
import { releaseExpiredBookings } from '@/app-layer/usecases/release-expired-bookings';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { POST as drawRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/draw/route';
import { POST as openRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/open/route';
import { POST as createRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/route';
import { POST as enterRoute } from '@/app/api/v1/tournaments/[id]/entries/route';
import { GET as playerDrawRoute } from '@/app/api/v1/tournaments/[id]/draw/route';
import { DELETE as withdrawRoute } from '@/app/api/v1/me/tournament-entries/[id]/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import {
  prismaTestClient,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A CLUB TOURNAMENT'S DRAW, THROUGH THE ROUTES (#580; decisions 40, 54, 55,
 * 57, 59, 61): the draw is made, a match goes on a court, its players report
 * the result as for any booking, and the draw moves on.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('a tournament draw', () => {
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let venueId: string;
  let resourceId: string;
  let desk: TestIdentity;
  let players: TestIdentity[];

  beforeEach(async () => {
    club = await seedTenant({}, db);
    ({ venueId, resourceId } = await seedVenue(club.tenantId, {}, db));
    const deskId = await seedAccount('CLUB', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: deskId, role: 'STAFF', status: 'ACTIVE' },
      }),
    );
    desk = await signInAs(db, {
      userId: deskId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'STAFF' }],
    });
    players = await Promise.all(
      Array.from({ length: 6 }, async (_, i) =>
        signInAs(db, {
          userId: await seedPlayer(db, club.tenantId, `p${i}`),
          memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
        }),
      ),
    );
    // Declared levels: p0 is the strongest, p5 the weakest.
    await asAppSuperuser(db, (tx) =>
      tx.playerSportLevel.createMany({
        data: players.map((p, i) => ({ userId: p.userId, sport: 'PADEL', level: 7 - i })),
      }),
    );
  });

  const slug = () => club.tenantSlug;
  const call = async (
    route: (
      req: NextRequest,
      ctx: { params: Promise<Record<string, string>> },
    ) => Promise<Response>,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    who: TestIdentity,
    params: Record<string, string>,
    body?: unknown,
  ) => {
    const res = await route(
      new NextRequest(`http://t${url}`, {
        method,
        headers: { authorization: `Bearer ${who.bearer}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /** A tournament with `n` players confirmed, sign-up still open. */
  async function withEntries(n: number, over: Record<string, unknown> = {}): Promise<string> {
    const made = await call(
      createRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments`,
      desk,
      { slug: slug() },
      {
        name: 'Купа',
        sport: 'PADEL',
        format: 'SINGLE_ELIMINATION',
        teamSize: 1,
        venueId,
        startsAt: new Date(Date.now() + 7 * DAY).toISOString(),
        drawSize: 8,
        entryFeeCents: 0,
        feePayment: 'AT_CLUB',
        ...over,
      },
    );
    const id = made.body.data.id as string;
    await call(
      openRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments/${id}/open`,
      desk,
      { slug: slug(), id },
    );
    for (const p of players.slice(0, n)) {
      const entered = await call(
        enterRoute as never,
        'POST',
        `/api/v1/tournaments/${id}/entries`,
        p,
        { id },
        {},
      );
      const entryId = entered.body.data.myEntry.id as string;
      await call(
        confirmEntryRoute as never,
        'POST',
        `/api/v1/t/${slug()}/admin/tournament-entries/${entryId}/confirm`,
        desk,
        {
          slug: slug(),
          id: entryId,
        },
      );
    }
    return id;
  }

  const draw = (id: string, body: Record<string, unknown> = {}) =>
    call(
      drawRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments/${id}/draw`,
      desk,
      { slug: slug(), id },
      body,
    );
  const schedule = (matchId: string, startTs: Date) =>
    call(
      scheduleRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournament-matches/${matchId}/schedule`,
      desk,
      {
        slug: slug(),
        id: matchId,
      },
      { resourceId, startTs: startTs.toISOString(), durationMinutes: 60 },
    );
  const walkover = (matchId: string, winnerSide: 0 | 1 | null) =>
    call(
      walkoverRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournament-matches/${matchId}/walkover`,
      desk,
      {
        slug: slug(),
        id: matchId,
      },
      { winnerSide },
    );
  const playerOf = (entry: { players: Array<{ userId: string }> }) =>
    players.find((p) => p.userId === entry.players[0]!.userId)!;
  const tournamentStatus = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.tournament.findUniqueOrThrow({ where: { id }, select: { status: true } }),
    ).then((t) => t.status);

  it('a knockout of four, seeded by level, with a match for third: played, walked over, finished', async () => {
    const id = await withEntries(4);
    const drawn = await draw(id, { thirdPlace: true });
    expect(drawn.status).toBe(201);
    const [semis, final] = drawn.body.data.knockout as Array<Array<Record<string, any>>>;
    expect(semis).toHaveLength(2);
    expect(final).toHaveLength(1);
    // Seeds 1 and 2 (p0, p1) are in different semi-finals.
    const semiOf = (u: string) =>
      semis.findIndex((m) => [m.sideA, m.sideB].some((s) => s.players[0].userId === u));
    expect(semiOf(players[0]!.userId)).not.toBe(semiOf(players[1]!.userId));
    expect(drawn.body.data.thirdPlace).toMatchObject({ status: 'PENDING' });
    expect(await tournamentStatus(id)).toBe('IN_PROGRESS');

    // Semi 1 goes on a court, yesterday, and is played: the booking's result.
    const semi = semis[0]!;
    const on = await schedule(semi.id, new Date(Date.now() - DAY));
    expect(on.status).toBe(200);
    const bookingId = on.body.data.knockout[0][0].scheduled.bookingId as string;
    await asAppSuperuser(db, (tx) =>
      tx.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } }),
    );
    const a = playerOf(semi.sideA);
    const b = playerOf(semi.sideB);

    // The draw sets the sides: a booking's result cannot change them.
    const report = (who: TestIdentity, sides: string[][]) =>
      call(
        reportRoute as never,
        'POST',
        `/api/v1/me/bookings/${bookingId}/result`,
        who,
        { id: bookingId },
        {
          sides,
          score: [
            [6, 3],
            [6, 4],
          ],
        },
      );
    // Side B's player reports a win for side B.
    const reported = await report(b, [[b.userId], [a.userId]]);
    expect(reported.status).toBe(201);
    expect(reported.body.data.fixedSides).toHaveLength(2);
    // A player on a tournament match does not leave its booking (#580).
    const left = await call(
      leaveRoute as never,
      'DELETE',
      `/api/v1/me/bookings/${bookingId}/participation`,
      a,
      {
        id: bookingId,
      },
    );
    expect(left.body.error.code).toBe('BOOKING_IS_TOURNAMENT_MATCH');
    // Side A confirms: it counts, and B goes to the final, A to third place.
    const reportId = reported.body.data.result.id as string;
    expect(
      (
        await call(
          answerConfirmRoute as never,
          'POST',
          `/api/v1/me/results/${reportId}/confirm`,
          a,
          { id: reportId },
          {},
        )
      ).status,
    ).toBe(200);

    const after = await call(playerDrawRoute as never, 'GET', `/api/v1/tournaments/${id}/draw`, a, {
      id,
    });
    const s1 = after.body.data.knockout[0][0];
    expect(s1).toMatchObject({ status: 'PLAYED', winnerSide: 1, mine: true });
    // The score as the match's sides read it: side A first.
    expect(s1.score).toEqual([
      [3, 6],
      [4, 6],
    ]);
    const finalNow = after.body.data.knockout[1][0];
    expect([finalNow.sideA?.players[0].userId, finalNow.sideB?.players[0].userId]).toContain(
      b.userId,
    );
    const third = after.body.data.thirdPlace;
    expect([third.sideA?.players[0].userId, third.sideB?.players[0].userId]).toContain(a.userId);
    // Played results are rated (29).
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.skillRatingHistory.count({ where: { userId: b.userId } }),
      ),
    ).toBe(1);

    // Semi 2 is a walkover: the final and the match for third are ready.
    const w = await walkover(semis[1]!.id, 0);
    expect(w.body.data.knockout[1][0].status).toBe('READY');
    expect(w.body.data.thirdPlace.status).toBe('READY');

    // A finalist withdraws (59): the final is a walkover to the other.
    const finalist = playerOf(w.body.data.knockout[1][0].sideA);
    const mine = await asAppSuperuser(db, (tx) =>
      tx.tournamentEntry.findFirstOrThrow({
        where: { tournamentId: id, playerUserId: finalist.userId },
      }),
    );
    expect(
      (
        await withdrawRoute(
          new NextRequest(`http://t/api/v1/me/tournament-entries/${mine.id}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${finalist.bearer}` },
          }),
          { params: Promise.resolve({ id: mine.id }) },
        )
      ).status,
    ).toBe(200);
    const done = await call(playerDrawRoute as never, 'GET', `/api/v1/tournaments/${id}/draw`, a, {
      id,
    });
    expect(done.body.data.knockout[1][0]).toMatchObject({ status: 'WALKOVER', winnerSide: 1 });
    // The match for third still to play; then it is over.
    expect(await tournamentStatus(id)).toBe('IN_PROGRESS');
    await walkover(done.body.data.thirdPlace.id, 0);
    expect(await tournamentStatus(id)).toBe('COMPLETE');
  });

  it('six in a knockout of eight: the top two seeds get the byes', async () => {
    const id = await withEntries(6);
    const drawn = await draw(id);
    const round1 = drawn.body.data.knockout[0] as Array<Record<string, any>>;
    const byes = round1
      .filter((m) => m.status === 'WALKOVER')
      .map((m) => (m.sideA ?? m.sideB).players[0].userId);
    expect(byes.sort()).toEqual([players[0]!.userId, players[1]!.userId].sort());
    // Each went straight on to round 2.
    const round2 = drawn.body.data.knockout[1] as Array<Record<string, any>>;
    const there = round2
      .flatMap((m) => [m.sideA, m.sideB])
      .filter(Boolean)
      .map((s: any) => s.players[0].userId);
    expect(there.sort()).toEqual(byes.sort());
  });

  it('groups (55): snake-seeded, round robins, then the top two of each into a knockout', async () => {
    const id = await withEntries(6, { format: 'GROUPS_KNOCKOUT' });
    const drawn = await draw(id, { groupCount: 2, qualifiersPerGroup: 2 });
    const groups = drawn.body.data.groups as Array<{
      groupNo: number;
      matches: Array<Record<string, any>>;
    }>;
    expect(groups.map((g) => g.matches.length)).toEqual([3, 3]);
    expect(drawn.body.data.knockout).toEqual([]);
    // Every group match decided (walkovers to side A): the knockout is drawn.
    let last: Record<string, any> = {};
    for (const g of groups) for (const m of g.matches) last = await walkover(m.id, 0);
    expect(last.body.data.knockout[0]).toHaveLength(2);
    const qualifiers = last.body.data.knockout[0].flatMap((m: any) => [m.sideA.id, m.sideB.id]);
    expect(new Set(qualifiers).size).toBe(4);
  });

  it('a round robin of three is over when its three matches are', async () => {
    const id = await withEntries(3, { format: 'ROUND_ROBIN' });
    const drawn = await draw(id);
    const matches = drawn.body.data.groups[0].matches as Array<Record<string, any>>;
    expect(matches).toHaveLength(3);
    for (const m of matches) await walkover(m.id, 0);
    expect(await tournamentStatus(id)).toBe('COMPLETE');
    const tableRows = (
      await call(playerDrawRoute as never, 'GET', `/api/v1/tournaments/${id}/draw`, players[0]!, {
        id,
      })
    ).body.data.groups[0].table as Array<{ points: number }>;
    // 3 matches, 3 points a win: 9 points in all.
    expect(tableRows.reduce((n, r) => n + r.points, 0)).toBe(9);
  });

  it('the draw is made once, with two entries at least; the waiting ones are declined', async () => {
    const id = await withEntries(1);
    expect((await draw(id)).body.error.code).toBe('TOURNAMENT_TOO_FEW');
    const two = await withEntries(2);
    // A third entry still waits when the draw is made: it does not get in.
    const late = await call(
      enterRoute as never,
      'POST',
      `/api/v1/tournaments/${two}/entries`,
      players[5]!,
      { id: two },
      {},
    );
    expect((await draw(two)).status).toBe(201);
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.tournamentEntry.findUniqueOrThrow({
          where: { id: late.body.data.myEntry.id },
          select: { status: true },
        }),
      ),
    ).toEqual({ status: 'DECLINED' });
    expect((await draw(two)).body.error.code).toBe('TOURNAMENT_STATE');
    // A player cannot make a draw.
    expect(
      (
        await call(
          drawRoute as never,
          'POST',
          `/api/v1/t/${slug()}/admin/tournaments/${two}/draw`,
          players[0]!,
          {
            slug: slug(),
            id: two,
          },
          {},
        )
      ).status,
    ).toBe(403);
  });

  describe('Americano and Mexicano (#590; decisions 43, 56, 60)', () => {
    it('Americano: two against two, played to the points, a draw allowed, no ratings', async () => {
      const id = await withEntries(4, { format: 'AMERICANO' });
      const drawn = await draw(id, { rounds: 3, pointsPerMatch: 24 });
      expect(drawn.status).toBe(201);
      const matches = drawn.body.data.groups[0].matches as Array<Record<string, any>>;
      // Four players: one match a round, three rounds, every partner once.
      expect(matches).toHaveLength(3);
      const partners = matches.flatMap((m) => [
        [m.sideA.id, m.sideA2.id].sort().join('|'),
        [m.sideB.id, m.sideB2.id].sort().join('|'),
      ]);
      expect(new Set(partners).size).toBe(6);

      // Round 1 on a court yesterday; its four players report it as a booking.
      const first = matches[0]!;
      const on = await schedule(first.id, new Date(Date.now() - DAY));
      const bookingId = on.body.data.groups[0].matches[0].scheduled.bookingId as string;
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } }),
      );
      const sideA = [first.sideA, first.sideA2].map((e: any) => e.players[0].userId);
      const sideB = [first.sideB, first.sideB2].map((e: any) => e.players[0].userId);
      const reporter = players.find((p) => p.userId === sideA[0])!;
      const answerer = players.find((p) => p.userId === sideB[0])!;
      const report = (score: number[][]) =>
        call(
          reportRoute as never,
          'POST',
          `/api/v1/me/bookings/${bookingId}/result`,
          reporter,
          { id: bookingId },
          {
            sides: [sideA, sideB],
            score,
          },
        );
      expect((await report([[13, 10]])).body.error.code).toBe('INVALID_SCORE');
      expect(
        (
          await report([
            [6, 4],
            [6, 3],
          ])
        ).body.error.code,
      ).toBe('INVALID_SCORE');
      // A level match is a result here (56).
      const reported = await report([[12, 12]]);
      expect(reported.status).toBe(201);
      expect(reported.body.data.pointsTotal).toBe(24);
      const reportId = reported.body.data.result.id as string;
      await call(
        answerConfirmRoute as never,
        'POST',
        `/api/v1/me/results/${reportId}/confirm`,
        answerer,
        { id: reportId },
        {},
      );

      const after = await call(
        playerDrawRoute as never,
        'GET',
        `/api/v1/tournaments/${id}/draw`,
        reporter,
        { id },
      );
      expect(after.body.data.groups[0].matches[0]).toMatchObject({
        status: 'PLAYED',
        winnerSide: null,
        score: [[12, 12]],
      });
      // Each player keeps their pair's points: twelve each.
      const table = after.body.data.groups[0].table as Array<{ points: number; drawn: number }>;
      expect(table.map((r) => r.points).sort()).toEqual([12, 12, 12, 12]);
      // No ratings (43).
      expect(
        await asAppSuperuser(db, (tx) =>
          tx.skillRatingHistory.count({ where: { userId: { in: [...sideA, ...sideB] } } }),
        ),
      ).toBe(0);
    });

    it('Mexicano: one round at a time from the table; the round off goes round', async () => {
      const id = await withEntries(5, { format: 'MEXICANO' });
      const drawn = await draw(id, { rounds: 2, pointsPerMatch: 24 });
      const round1 = drawn.body.data.groups[0].matches as Array<Record<string, any>>;
      // Five players: one match, one sits out; no second round yet.
      expect(round1).toHaveLength(1);
      const on1 = new Set(
        [round1[0]!.sideA, round1[0]!.sideA2, round1[0]!.sideB, round1[0]!.sideB2].map(
          (e: any) => e.id,
        ),
      );
      const after1 = await walkover(round1[0]!.id, 0);
      const both = after1.body.data.groups[0].matches as Array<Record<string, any>>;
      expect(both).toHaveLength(2);
      const round2 = both.find((m) => m.round === 2)!;
      const on2 = [round2.sideA, round2.sideA2, round2.sideB, round2.sideB2].map((e: any) => e.id);
      // Whoever sat out round 1 plays round 2.
      const sat = (drawn.body.data.groups[0].table as Array<{ entryId: string }>)
        .map((r) => r.entryId)
        .find((e) => !on1.has(e))!;
      expect(on2).toContain(sat);
      await walkover(round2.id, 1);
      expect(await tournamentStatus(id)).toBe('COMPLETE');
    });
  });

  describe('a league over weeks (#591; decisions 44, 57, 58)', () => {
    it('divisions by level, a round a deadline, and a loss for both counted as a loss', async () => {
      const id = await withEntries(6, { format: 'LEAGUE' });
      expect((await draw(id, { divisionCount: 2, roundDays: 7 })).body.error.details).toMatchObject(
        {
          field: 'firstDeadline',
        },
      );
      const first = new Date(Date.now() + 3 * DAY);
      const drawn = await draw(id, {
        divisionCount: 2,
        firstDeadline: first.toISOString(),
        roundDays: 7,
      });
      expect(drawn.status).toBe(201);
      const groups = drawn.body.data.groups as Array<{
        groupNo: number;
        matches: Array<Record<string, any>>;
      }>;
      // Two divisions of three: everyone plays everyone, a round each week.
      expect(groups.map((g) => g.matches.length)).toEqual([3, 3]);
      const deadlines = [...new Set(groups[0]!.matches.map((m) => m.deadline as string))].sort();
      expect(deadlines.map((d) => Math.round((Date.parse(d) - first.getTime()) / DAY))).toEqual([
        0, 7, 14,
      ]);
      expect(groups[0]!.matches.every((m) => m.status === 'READY' && m.overdue === false)).toBe(
        true,
      );

      // Past the deadline the match waits for the club (58).
      const m = groups[0]!.matches.find((x) => x.round === 1)!;
      await asAppSuperuser(db, (tx) =>
        tx.tournamentMatch.update({
          where: { id: m.id },
          data: { deadline: new Date(Date.now() - DAY) },
        }),
      );
      const late = await call(
        playerDrawRoute as never,
        'GET',
        `/api/v1/tournaments/${id}/draw`,
        players[0]!,
        { id },
      );
      expect(late.body.data.groups[0].matches.find((x: any) => x.id === m.id).overdue).toBe(true);

      // The club gives it as lost by both: a loss each, no points.
      const both = await walkover(m.id, null);
      expect(both.status).toBe(200);
      const decided = both.body.data.groups[0];
      expect(decided.matches.find((x: any) => x.id === m.id)).toMatchObject({
        status: 'WALKOVER',
        winnerSide: null,
        overdue: false,
      });
      for (const side of [m.sideA.id, m.sideB.id]) {
        expect(decided.table.find((r: any) => r.entryId === side)).toMatchObject({
          played: 1,
          lost: 1,
          points: 0,
        });
      }
    });

    it('a loss for both is only a league’s', async () => {
      const id = await withEntries(4, { format: 'ROUND_ROBIN' });
      const drawn = await draw(id);
      const m = drawn.body.data.groups[0].matches[0];
      const res = await walkover(m.id, null);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOURNAMENT_INVALID');
    });

    it('the club sets the divisions by hand: every confirmed entry in one', async () => {
      const id = await withEntries(4, { format: 'LEAGUE' });
      const entries = await asAppSuperuser(db, (tx) =>
        tx.tournamentEntry.findMany({
          where: { tournamentId: id },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
      );
      const ids = entries.map((e) => e.id);
      const at = new Date(Date.now() + DAY).toISOString();
      const missing = await draw(id, { divisions: [ids.slice(0, 3)], firstDeadline: at });
      expect(missing.body.error.details).toMatchObject({ field: 'divisions' });
      const ok = await draw(id, { divisions: [ids.slice(0, 2), ids.slice(2)], firstDeadline: at });
      expect(ok.status).toBe(201);
      const tables = ok.body.data.groups.map((g: any) => g.table.map((r: any) => r.entryId).sort());
      expect(tables).toEqual([ids.slice(0, 2).sort(), ids.slice(2).sort()]);
    });
  });

  describe('a league match placed by its players (#591; decisions 62, 63)', () => {
    beforeEach(async () => {
      // The court is open every day, 06:00 to 23:00.
      await asAppSuperuser(db, (tx) =>
        tx.resourceAvailability.createMany({
          data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            tenantId: club.tenantId,
            resourceId,
            dayOfWeek,
            openTime: new Date('1970-01-01T06:00:00Z'),
            closeTime: new Date('1970-01-01T23:00:00Z'),
          })),
        }),
      );
    });

    /** 10:00 at the club, `days` from today. */
    const tenAm = (days: number) =>
      fromZonedTime(
        `${formatInTimeZone(new Date(Date.now() + days * DAY), 'Europe/Sofia', 'yyyy-MM-dd')}T10:00:00`,
        'Europe/Sofia',
      );
    const propose = (who: TestIdentity, matchId: string, startTs: Date) =>
      call(
        proposeRoute as never,
        'POST',
        `/api/v1/me/tournament-matches/${matchId}/proposal`,
        who,
        { id: matchId },
        {
          resourceId,
          startTs: startTs.toISOString(),
          durationMinutes: 60,
        },
      );
    const accept = (who: TestIdentity, matchId: string) =>
      call(
        acceptRoute as never,
        'POST',
        `/api/v1/me/tournament-matches/${matchId}/proposal/accept`,
        who,
        {
          id: matchId,
        },
      );
    const letGo = (who: TestIdentity, matchId: string) =>
      call(
        letGoRoute as never,
        'DELETE',
        `/api/v1/me/tournament-matches/${matchId}/proposal`,
        who,
        { id: matchId },
      );

    async function leagueMatch() {
      const id = await withEntries(2, { format: 'LEAGUE' });
      const drawn = await draw(id, { firstDeadline: new Date(Date.now() + 7 * DAY).toISOString() });
      const m = drawn.body.data.groups[0].matches[0] as Record<string, any>;
      const a = players.find((p) => p.userId === m.sideA.players[0].userId)!;
      const b = players.find((p) => p.userId === m.sideB.players[0].userId)!;
      return { id, m, a, b };
    }
    const bookingOf = (bookingId: string) =>
      asAppSuperuser(db, (tx) =>
        tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { status: true, bookedByUserId: true, totalCents: true, expiresAt: true },
        }),
      );

    it('one side proposes and the court is held at its price; the other side accepts', async () => {
      const { m, a, b } = await leagueMatch();
      // Nobody else's match to place, and not in the next two hours.
      expect((await propose(players[5]!, m.id, tenAm(3))).status).toBe(404);
      const soon = await propose(a, m.id, new Date(Date.now() + HOUR));
      expect(soon.body.error.details).toMatchObject({ field: 'startTs' });

      const proposed = await propose(a, m.id, tenAm(3));
      expect(proposed.status).toBe(201);
      const shown = proposed.body.data.groups[0].matches[0];
      expect(shown).toMatchObject({ scheduled: null, mySide: 0 });
      expect(shown.proposal).toMatchObject({ side: 0, priceCents: 2400 });
      // In the proposer's name, at the court's price, held for a day (62, 63).
      const held = await bookingOf(shown.proposal.bookingId);
      expect(held).toMatchObject({ status: 'PENDING', bookedByUserId: a.userId, totalCents: 2400 });
      expect(Math.abs(held.expiresAt!.getTime() - (Date.now() + DAY))).toBeLessThan(5 * 60_000);

      // One proposal at a time; the proposer does not answer their own.
      expect((await propose(b, m.id, tenAm(4))).body.error.code).toBe('TOURNAMENT_MATCH_PLACED');
      expect((await accept(a, m.id)).body.error.code).toBe('TOURNAMENT_NO_PROPOSAL');
      // The other side is told, after the draw's own notice.
      expect(
        await asAppSuperuser(db, (tx) =>
          tx.notification.count({ where: { userId: b.userId, kind: 'TOURNAMENT_ROUND' } }),
        ),
      ).toBe(2);

      const accepted = await accept(b, m.id);
      expect(accepted.status).toBe(200);
      const placed = accepted.body.data.groups[0].matches[0];
      expect(placed.proposal).toBeNull();
      expect(placed.scheduled).toMatchObject({ bookingId: shown.proposal.bookingId });
      expect(await bookingOf(shown.proposal.bookingId)).toMatchObject({
        status: 'CONFIRMED',
        expiresAt: null,
      });
    });

    it('declined, the court is free again and the same time can be proposed anew', async () => {
      const { m, a, b } = await leagueMatch();
      const first = await propose(a, m.id, tenAm(3));
      const firstId = first.body.data.groups[0].matches[0].proposal.bookingId as string;
      const declined = await letGo(b, m.id);
      expect(declined.status).toBe(200);
      expect(declined.body.data.groups[0].matches[0].proposal).toBeNull();
      expect((await bookingOf(firstId)).status).toBe('CANCELLED');
      // The proposer is told, after the draw's own notice.
      expect(
        await asAppSuperuser(db, (tx) =>
          tx.notification.count({ where: { userId: a.userId, kind: 'TOURNAMENT_ROUND' } }),
        ),
      ).toBe(2);
      // A new booking, not the released one replayed.
      const again = await propose(a, m.id, tenAm(3));
      expect(again.status).toBe(201);
      expect(again.body.data.groups[0].matches[0].proposal.bookingId).not.toBe(firstId);
    });

    it('a hold nobody answers lapses, and the match can be placed again', async () => {
      const { id, m, a, b } = await leagueMatch();
      await propose(a, m.id, tenAm(3));
      const swept = await releaseExpiredBookings(db, { now: new Date(Date.now() + 2 * DAY) });
      expect(swept.released).toBeGreaterThanOrEqual(1);
      expect((await accept(b, m.id)).body.error.code).toBe('TOURNAMENT_NO_PROPOSAL');
      const view = await call(
        playerDrawRoute as never,
        'GET',
        `/api/v1/tournaments/${id}/draw`,
        b,
        { id },
      );
      expect(view.body.data.groups[0].matches[0]).toMatchObject({
        proposal: null,
        scheduled: null,
      });
      expect((await propose(b, m.id, tenAm(4))).status).toBe(201);
    });
  });
});
