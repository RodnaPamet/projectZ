import { NextRequest } from 'next/server';

import { POST as askRoute } from '@/app/api/v1/games/[id]/requests/route';
import { GET as gameRoute } from '@/app/api/v1/games/[id]/route';
import { GET as gamesRoute } from '@/app/api/v1/games/route';
import { POST as acceptRoute } from '@/app/api/v1/me/bookings/[id]/game/requests/[requestId]/accept/route';
import { POST as declineRoute } from '@/app/api/v1/me/bookings/[id]/game/requests/[requestId]/decline/route';
import {
  DELETE as closeRoute,
  GET as bookingGameRoute,
  PUT as openRoute,
} from '@/app/api/v1/me/bookings/[id]/game/route';
import { DELETE as removeRoute } from '@/app/api/v1/me/bookings/[id]/participants/[participantId]/route';
import { DELETE as leaveRoute } from '@/app/api/v1/me/bookings/[id]/participation/route';
import { DELETE as withdrawRoute } from '@/app/api/v1/me/game-requests/[id]/route';
import { GET as myRequestsRoute } from '@/app/api/v1/me/game-requests/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { markNoShow, markPlayerNoShow } from '@/app-layer/usecases/booking-outcome';
import { acceptBookingInvite, createBookingInviteLink } from '@/app-layer/usecases/booking-players';
import { noShowStanding } from '@/app-layer/usecases/booking-rules';
import { deleteAccount } from '@/app-layer/usecases/account-deletion';
import { exportMyData } from '@/app-layer/usecases/data-export';
import { lapseOpenPlayRequests } from '@/app-layer/usecases/open-play';
import { loadDiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Open play (#376) end to end through the v1 routes, on a real database: the
 * booker opens a booking, players ask, the booker answers, and the owner's
 * rules of 2026-10-13 hold — every join is asked, a joiner leaves until the
 * club's cutoff only, an unanswered request lapses at it, and a cancelled
 * booking closes the game and tells everyone.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const BASE = 'http://localhost:3000/api/v1';

interface ApiError {
  error: { code: string };
}
interface Game {
  id: string;
  spotsLeft: number;
  open: boolean;
  levelMin: number | null;
  levelMax: number | null;
  note: string | null;
  playersCount: number;
  venue: { id: string; slug: string; name: string; city: string };
  booker: { firstName: string | null };
  viewer: {
    isBooker: boolean;
    isPlaying: boolean;
    request: { id: string; status: string } | null;
  } | null;
}
interface BookingGame {
  viewerRole: string;
  canOpen: boolean;
  maxSpots: number;
  game: {
    id: string;
    open: boolean;
    spotsLeft: number;
    accepted: number;
    closedAt: string | null;
  } | null;
  requests: Array<{
    id: string;
    status: string;
    note: string | null;
    participantId: string | null;
    player: {
      userId: string;
      name: string | null;
      sports: Array<{ sport: string; level: number }>;
    };
  }>;
  myRequest: { id: string; status: string } | null;
}

const auth = (who: TestIdentity | null): Record<string, string> =>
  who ? { authorization: `Bearer ${who.bearer}` } : {};

type AnyRoute = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;
const r = (fn: unknown) => fn as AnyRoute;

async function call<T>(
  route: AnyRoute,
  who: TestIdentity | null,
  path: string,
  init: { method?: string; body?: unknown; params?: Record<string, string> } = {},
) {
  const res = await route(
    new NextRequest(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...auth(who),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    { params: Promise.resolve(init.params ?? {}) },
  );
  const text = await res.text();
  return { res, body: (text ? JSON.parse(text) : {}) as { data: T } & ApiError };
}

describe('open play (#376)', () => {
  let club: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let booker: TestIdentity;
  let asker: TestIdentity;
  let other: TestIdentity;
  let third: TestIdentity;

  const person = async (label: string, name: string) => {
    const id = await seedPlayer(db, club.tenantId, label);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id }, data: { name, accountKind: 'PLAYER' } }),
    );
    return signInAs(db, {
      userId: id,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  };

  const book = (who: TestIdentity, startsInHours: number) => {
    const start = new Date(Date.now() + startsInHours * HOUR);
    return asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: who.userId,
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      }),
    ).then((b) => b.id);
  };

  const setCutoffHours = (hours: number) =>
    asAppSuperuser(db, (tx) =>
      tx.venue.update({ where: { id: court.venueId }, data: { cancellationCutoffHours: hours } }),
    );

  const open = (who: TestIdentity, id: string, body: Record<string, unknown>) =>
    call<BookingGame>(r(openRoute), who, `/me/bookings/${id}/game`, {
      method: 'PUT',
      params: { id },
      body,
    });
  const bookingGame = (who: TestIdentity, id: string) =>
    call<BookingGame>(r(bookingGameRoute), who, `/me/bookings/${id}/game`, { params: { id } });
  const games = (who: TestIdentity | null, query = '') =>
    call<{ items: Game[]; nextCursor: string | null }>(r(gamesRoute), who, `/games${query}`);
  const ask = (who: TestIdentity | null, gameId: string, note?: string) =>
    call<Game>(r(askRoute), who, `/games/${gameId}/requests`, {
      method: 'POST',
      params: { id: gameId },
      body: note === undefined ? {} : { note },
    });
  const answer = (who: TestIdentity, id: string, requestId: string, verb: 'accept' | 'decline') =>
    call<BookingGame>(
      r(verb === 'accept' ? acceptRoute : declineRoute),
      who,
      `/me/bookings/${id}/game/requests/${requestId}/${verb}`,
      { method: 'POST', params: { id, requestId } },
    );
  const bell = (userId: string, kind: string) =>
    asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId, kind: kind as never } }),
    );
  const requestRow = (id: string) =>
    asAppSuperuser(db, (tx) => tx.openGameRequest.findUniqueOrThrow({ where: { id } }));

  /** A booking opened for `spots` more, and `who` asking to join it. */
  async function opened(spots = 2) {
    const id = await book(booker, 72);
    const { body } = await open(booker, id, {
      spots,
      levelMin: 3,
      levelMax: 4,
      note: 'Търсим двама',
    });
    return { id, gameId: body.data.game!.id };
  }

  beforeEach(async () => {
    club = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    booker = await person('booker', 'Иван Петров');
    asker = await person('asker', 'Мария Георгиева');
    other = await person('other', 'Петър Иванов');
    third = await person('third', 'Елена Димитрова');
    await asAppSuperuser(db, (tx) =>
      tx.playerSportLevel.create({ data: { userId: asker.userId, sport: 'PADEL', level: 4 } }),
    );
  });

  describe('opening and listing', () => {
    it('lists an opened booking for everyone, without user ids or the booking id', async () => {
      const { id, gameId } = await opened(2);

      const anon = await games(null);
      expect(anon.res.status).toBe(200);
      expect(anon.body.data.items).toHaveLength(1);
      const g = anon.body.data.items[0]!;
      expect(g).toMatchObject({
        id: gameId,
        spotsLeft: 2,
        open: true,
        levelMin: 3,
        levelMax: 4,
        note: 'Търсим двама',
        playersCount: 1,
        booker: { firstName: 'Иван' },
        viewer: null,
      });
      const wire = JSON.stringify(anon.body);
      expect(wire).not.toContain(booker.userId);
      expect(wire).not.toContain(id);

      // Filters.
      expect((await games(null, '?sport=TENNIS')).body.data.items).toHaveLength(0);
      expect((await games(null, '?sport=PADEL')).body.data.items).toHaveLength(1);
      expect((await games(null, '?city=София')).body.data.items).toHaveLength(1);
      expect((await games(null, '?city=Plovdiv')).body.data.items).toHaveLength(0);
      expect((await games(null, `?venue=${court.venueId}`)).body.data.items).toHaveLength(1);
      expect((await games(null, '?venue=nope')).body.data.items).toHaveLength(0);
      expect((await games(null, '?date=2000-01-01')).body.data.items).toHaveLength(0);
      expect((await games(null, '?date=nope')).res.status).toBe(400);

      // The booker sees it as theirs.
      const mine = await games(booker);
      expect(mine.body.data.items[0]!.viewer).toMatchObject({ isBooker: true, isPlaying: true });
    });

    it('asks for at most the free places, the booker only, before the cutoff', async () => {
      const id = await book(booker, 72);
      expect((await open(booker, id, { spots: 4 })).body.error.code).toBe('SPOTS_UNAVAILABLE');
      expect((await open(asker, id, { spots: 1 })).res.status).toBe(404);
      expect((await open(booker, id, { spots: 1, levelMin: 5, levelMax: 2 })).res.status).toBe(400);

      const late = await book(booker, 10);
      const refused = await open(booker, late, { spots: 1 });
      expect(refused.res.status).toBe(409);
      expect(refused.body.error.code).toBe('OPEN_PLAY_CUTOFF_PASSED');
      // …and a game past its cutoff is not listed.
      expect((await games(null)).body.data.items).toHaveLength(0);
    });

    it('a player added to the booking cannot open it', async () => {
      const id = await book(booker, 72);
      const link = await createBookingInviteLink({ userId: booker.userId, bookingId: id });
      await acceptBookingInvite({ userId: other.userId, token: link.token });
      const res = await open(other, id, { spots: 1 });
      expect(res.res.status).toBe(403);
      expect(res.body.error.code).toBe('BOOKER_ONLY');
    });
  });

  describe('asking and answering', () => {
    it('every join is a request the booker accepts; the player is then on the booking', async () => {
      const { id, gameId } = await opened(2);

      const asked = await ask(asker, gameId, 'Играя от 5 години');
      expect(asked.res.status).toBe(201);
      expect(asked.body.data.viewer!.request!.status).toBe('PENDING');
      // Asking again is the same request.
      expect((await ask(asker, gameId)).res.status).toBe(200);

      // The booker is told, by name.
      const told = await bell(booker.userId, 'OPEN_PLAY_REQUESTED');
      expect(told).toHaveLength(1);
      expect(told[0]!.title).toContain('Мария');
      expect(told[0]!.refType).toBe('open_game_request');

      // The booker sees the request with the asker's public card.
      const view = await bookingGame(booker, id);
      expect(view.body.data.requests).toHaveLength(1);
      const req = view.body.data.requests[0]!;
      expect(req).toMatchObject({
        status: 'PENDING',
        note: 'Играя от 5 години',
        player: {
          userId: asker.userId,
          name: 'Мария Георгиева',
          sports: [{ sport: 'PADEL', level: 4 }],
        },
      });
      // Not on the booking until accepted.
      expect(view.body.data.game!.accepted).toBe(0);

      const accepted = await answer(booker, id, req.id, 'accept');
      expect(accepted.res.status).toBe(200);
      expect(accepted.body.data.game).toMatchObject({ accepted: 1, spotsLeft: 1 });
      const row = await requestRow(req.id);
      expect(row.status).toBe('ACCEPTED');
      const place = await asAppSuperuser(db, (tx) =>
        tx.bookingParticipant.findUniqueOrThrow({ where: { id: row.participantId! } }),
      );
      expect(place.userId).toBe(asker.userId);
      expect(await bell(asker.userId, 'OPEN_PLAY_ACCEPTED')).toHaveLength(1);
      // Repeating the answer is not an error.
      expect((await answer(booker, id, req.id, 'accept')).res.status).toBe(200);

      // The joiner sees their own standing on the booking.
      const theirs = await bookingGame(asker, id);
      expect(theirs.body.data).toMatchObject({
        viewerRole: 'PARTICIPANT',
        requests: [],
        myRequest: { id: req.id, status: 'ACCEPTED' },
      });
      // And a joiner cannot ask again.
      expect((await ask(asker, gameId)).body.error.code).toBe('ALREADY_PLAYING');

      const audit = await asAppSuperuser(db, (tx) =>
        tx.auditEntry.findMany({
          where: { tenantId: club.tenantId, action: 'BOOKING_PLAYER_JOINED' },
        }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorUserId).toBe(booker.userId);
    });

    it('a full game leaves the listing and refuses asks; accepting past the spots is refused', async () => {
      const { id, gameId } = await opened(1);
      const a = await ask(asker, gameId);
      const b = await ask(other, gameId);
      const reqs = (await bookingGame(booker, id)).body.data.requests;
      const first = reqs.find((q) => q.player.userId === asker.userId)!;
      const second = reqs.find((q) => q.player.userId === other.userId)!;
      expect(a.res.status).toBe(201);
      expect(b.res.status).toBe(201);

      await answer(booker, id, first.id, 'accept');
      expect((await games(null)).body.data.items).toHaveLength(0);
      const refused = await answer(booker, id, second.id, 'accept');
      expect(refused.res.status).toBe(409);
      expect(refused.body.error.code).toBe('GAME_FULL');
      expect((await ask(third, gameId)).body.error.code).toBe('GAME_FULL');
    });

    it('a declined player is told and cannot ask again; a withdrawn one can', async () => {
      const { id, gameId } = await opened(2);
      await ask(asker, gameId);
      await ask(other, gameId);
      const reqs = (await bookingGame(booker, id)).body.data.requests;
      const declined = reqs.find((q) => q.player.userId === asker.userId)!;
      const withdrawn = reqs.find((q) => q.player.userId === other.userId)!;

      await answer(booker, id, declined.id, 'decline');
      expect((await requestRow(declined.id)).status).toBe('DECLINED');
      expect(await bell(asker.userId, 'OPEN_PLAY_DECLINED')).toHaveLength(1);
      expect((await ask(asker, gameId)).body.error.code).toBe('ASK_DECLINED');

      const w = await call(r(withdrawRoute), other, `/me/game-requests/${withdrawn.id}`, {
        method: 'DELETE',
        params: { id: withdrawn.id },
      });
      expect(w.res.status).toBe(204);
      expect((await requestRow(withdrawn.id)).status).toBe('WITHDRAWN');
      // Answering a withdrawn request is refused.
      expect((await answer(booker, id, withdrawn.id, 'accept')).body.error.code).toBe(
        'REQUEST_NOT_PENDING',
      );
      // Somebody else's request is not found.
      const notMine = await call(r(withdrawRoute), third, `/me/game-requests/${declined.id}`, {
        method: 'DELETE',
        params: { id: declined.id },
      });
      expect(notMine.res.status).toBe(404);
      expect((await ask(other, gameId)).res.status).toBe(201);

      const mine = await call<Array<{ id: string; status: string; bookingId: string | null }>>(
        r(myRequestsRoute),
        asker,
        '/me/game-requests',
      );
      expect(mine.body.data).toEqual([
        expect.objectContaining({ id: declined.id, status: 'DECLINED', bookingId: null }),
      ]);
    });

    it('a blocked pair never meet: the game is hidden and asking is not found', async () => {
      const { gameId } = await opened(2);
      await asAppSuperuser(db, (tx) =>
        tx.userBlock.create({ data: { blockerId: booker.userId, blockedId: asker.userId } }),
      );
      expect((await games(asker)).body.data.items).toHaveLength(0);
      expect((await ask(asker, gameId)).res.status).toBe(404);
      const one = await call(r(gameRoute), asker, `/games/${gameId}`, { params: { id: gameId } });
      expect(one.res.status).toBe(404);
    });

    it('asking needs a signed-in player account', async () => {
      const { gameId } = await opened(2);
      expect((await ask(null, gameId)).res.status).toBe(401);
      const coachId = await seedPlayer(db, club.tenantId, 'coach');
      await asAppSuperuser(db, async (tx) => {
        await tx.tenantMembership.deleteMany({ where: { userId: coachId } });
        await tx.user.update({ where: { id: coachId }, data: { accountKind: 'COACH' } });
      });
      const coach = await signInAs(db, { userId: coachId, memberships: [] });
      expect((await ask(coach, gameId)).res.status).toBe(403);
    });
  });

  describe('leaving, removal and the cutoff (rules 2 and 4)', () => {
    async function joined() {
      const g = await opened(2);
      await ask(asker, g.gameId);
      const req = (await bookingGame(booker, g.id)).body.data.requests[0]!;
      await answer(booker, g.id, req.id, 'accept');
      const row = await requestRow(req.id);
      return { ...g, requestId: req.id, participantId: row.participantId! };
    }

    it('a joiner leaves until the cutoff; the spot reopens and the booker is told', async () => {
      const { id, requestId } = await joined();
      const left = await call(r(leaveRoute), asker, `/me/bookings/${id}/participation`, {
        method: 'DELETE',
        params: { id },
      });
      expect(left.res.status).toBe(204);
      expect((await requestRow(requestId)).status).toBe('LEFT');
      expect(await bell(booker.userId, 'BOOKING_PLAYER_LEFT')).toHaveLength(1);
      expect((await bookingGame(booker, id)).body.data.game).toMatchObject({ spotsLeft: 2 });
    });

    it('after the cutoff a joiner can neither leave nor be removed', async () => {
      const { id, requestId, participantId } = await joined();
      await setCutoffHours(100);

      const left = await call(r(withdrawRoute), asker, `/me/game-requests/${requestId}`, {
        method: 'DELETE',
        params: { id: requestId },
      });
      expect(left.res.status).toBe(409);
      expect(left.body.error.code).toBe('OPEN_PLAY_CUTOFF_PASSED');
      const removed = await call(
        r(removeRoute),
        booker,
        `/me/bookings/${id}/participants/${participantId}`,
        { method: 'DELETE', params: { id, participantId } },
      );
      expect(removed.body.error.code).toBe('OPEN_PLAY_CUTOFF_PASSED');
      expect((await requestRow(requestId)).status).toBe('ACCEPTED');
    });

    it('the booker removes a joiner before the cutoff; they cannot ask again', async () => {
      const { id, gameId, requestId, participantId } = await joined();
      const removed = await call(
        r(removeRoute),
        booker,
        `/me/bookings/${id}/participants/${participantId}`,
        { method: 'DELETE', params: { id, participantId } },
      );
      expect(removed.res.status).toBe(204);
      expect((await requestRow(requestId)).status).toBe('REMOVED');
      expect((await ask(asker, gameId)).body.error.code).toBe('ASK_DECLINED');
    });

    it('an unanswered request lapses at the cutoff and the player is told', async () => {
      const { id, gameId } = await opened(2);
      await ask(asker, gameId);
      const req = (await bookingGame(booker, id)).body.data.requests[0]!;
      await setCutoffHours(100);

      // Every read shows it lapsed before the sweep runs, and it cannot be accepted.
      expect((await bookingGame(booker, id)).body.data.requests[0]!.status).toBe('LAPSED');
      expect((await answer(booker, id, req.id, 'accept')).body.error.code).toBe(
        'OPEN_PLAY_CUTOFF_PASSED',
      );

      expect(await lapseOpenPlayRequests()).toEqual({ lapsed: 1 });
      expect(await lapseOpenPlayRequests()).toEqual({ lapsed: 0 });
      expect((await requestRow(req.id)).status).toBe('LAPSED');
      expect(await bell(asker.userId, 'OPEN_PLAY_LAPSED')).toHaveLength(1);
    });

    it('a joiner who did not come is a no-show at the club; an invited player is not markable', async () => {
      const { id, participantId } = await joined();
      const link = await createBookingInviteLink({ userId: booker.userId, bookingId: id });
      await acceptBookingInvite({ userId: other.userId, token: link.token });
      const invited = await asAppSuperuser(db, (tx) =>
        tx.bookingParticipant.findFirstOrThrow({ where: { bookingId: id, userId: other.userId } }),
      );
      const after = new Date(Date.now() + 80 * HOUR);

      await runInTenantContext(club.tenantId, (tx) =>
        markPlayerNoShow(tx, club.tenantId, {
          bookingId: id,
          participantId,
          actorUserId: booker.userId,
          now: after,
        }),
      );
      await expect(
        runInTenantContext(club.tenantId, (tx) =>
          markPlayerNoShow(tx, club.tenantId, {
            bookingId: id,
            participantId: invited.id,
            actorUserId: booker.userId,
            now: after,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'NOT_FOUND' });

      const standing = await runInTenantContext(club.tenantId, (tx) =>
        noShowStanding(tx, club.tenantId, asker.userId, after),
      );
      expect(standing.recentNoShows).toBe(1);
      // The booking-level no-show is still the booker's alone.
      await runInTenantContext(club.tenantId, (tx) =>
        markNoShow(tx, club.tenantId, { bookingId: id, actorUserId: booker.userId, now: after }),
      );
      const again = await runInTenantContext(club.tenantId, (tx) =>
        noShowStanding(tx, club.tenantId, asker.userId, after),
      );
      expect(again.recentNoShows).toBe(1);
    });
  });

  describe('closing and cancelling', () => {
    it('closing tells the waiting askers and keeps the accepted; reopening lets them ask again', async () => {
      const { id, gameId } = await opened(2);
      await ask(asker, gameId);
      await ask(other, gameId);
      const reqs = (await bookingGame(booker, id)).body.data.requests;
      const acceptedReq = reqs.find((q) => q.player.userId === asker.userId)!;
      const waiting = reqs.find((q) => q.player.userId === other.userId)!;
      await answer(booker, id, acceptedReq.id, 'accept');

      const closed = await call<BookingGame>(r(closeRoute), booker, `/me/bookings/${id}/game`, {
        method: 'DELETE',
        params: { id },
      });
      expect(closed.body.data.game!.closedAt).not.toBeNull();
      expect((await requestRow(waiting.id)).status).toBe('CLOSED');
      expect((await requestRow(acceptedReq.id)).status).toBe('ACCEPTED');
      expect(await bell(other.userId, 'OPEN_PLAY_CLOSED')).toHaveLength(1);
      expect((await games(null)).body.data.items).toHaveLength(0);
      expect((await ask(third, gameId)).body.error.code).toBe('GAME_CLOSED');

      await open(booker, id, { spots: 1 });
      expect((await games(null)).body.data.items).toHaveLength(1);
      expect((await ask(other, gameId)).res.status).toBe(201);
    });

    it('a cancelled booking closes the game and tells everyone', async () => {
      const { id, gameId } = await opened(2);
      await ask(asker, gameId);
      await ask(other, gameId);
      const reqs = (await bookingGame(booker, id)).body.data.requests;
      const joinedReq = reqs.find((q) => q.player.userId === asker.userId)!;
      const waiting = reqs.find((q) => q.player.userId === other.userId)!;
      await answer(booker, id, joinedReq.id, 'accept');

      const cancelled = await call(
        r(cancelRoute),
        booker,
        `/t/${club.tenantSlug}/bookings/${id}/cancel`,
        { method: 'POST', params: { slug: club.tenantSlug, id }, body: {} },
      );
      expect(cancelled.res.status).toBe(200);
      expect((await requestRow(waiting.id)).status).toBe('CLOSED');
      const closedBell = await bell(other.userId, 'OPEN_PLAY_CLOSED');
      expect(closedBell).toHaveLength(1);
      expect(await bell(asker.userId, 'BOOKING_CANCELLED')).toHaveLength(1);
      const game = await asAppSuperuser(db, (tx) =>
        tx.openGame.findUniqueOrThrow({ where: { id: gameId } }),
      );
      expect(game.closedAt).not.toBeNull();
    });
  });

  describe('the club', () => {
    it('sees a joiner on the booking in its diary, «през Игри», named and never by address', async () => {
      const { id, gameId } = await opened(2);
      await ask(asker, gameId);
      const req = (await bookingGame(booker, id)).body.data.requests[0]!;
      await answer(booker, id, req.id, 'accept');

      const start = await asAppSuperuser(db, (tx) =>
        tx.booking.findUniqueOrThrow({ where: { id }, select: { startTs: true } }),
      );
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(
        start.startTs,
      );
      const diary = await loadDiaryDay(club.tenantId, day, {
        locale: 'bg',
        labels: { unknownPlayer: 'Играч', guest: 'Гост', deletedUser: 'Изтрит' },
      });
      const entry = diary.bookings.find((b) => b.id === id)!;
      expect(entry.players).toEqual([
        expect.objectContaining({
          name: 'Мария Георгиева',
          viaOpenPlay: true,
          noShow: false,
          // Not started yet.
          canMarkNoShow: false,
        }),
      ]);
    });
  });

  describe('a person’s data', () => {
    it('exports their games and requests, and deleting the account removes the requests and the bell rows that name them', async () => {
      const { id, gameId } = await opened(2);
      await ask(asker, gameId, 'Бележка');

      const exported = await exportMyData(asker.userId);
      expect(exported!.openPlay.requests).toEqual([
        expect.objectContaining({ status: 'PENDING', note: 'Бележка' }),
      ]);
      expect(exported!.notificationSettings.email.openPlay).toBe(true);
      const bookerExport = await exportMyData(booker.userId);
      expect(bookerExport!.openPlay.gamesOpened).toEqual([
        expect.objectContaining({ bookingId: id, note: 'Търсим двама', spotsWanted: 2 }),
      ]);

      expect(await bell(booker.userId, 'OPEN_PLAY_REQUESTED')).toHaveLength(1);
      await runAsSuperuser((tx) => deleteAccount(tx, { userId: asker.userId, by: 'self' }));
      expect(await bell(booker.userId, 'OPEN_PLAY_REQUESTED')).toHaveLength(0);
      const left = await asAppSuperuser(db, (tx) =>
        tx.openGameRequest.count({ where: { userId: asker.userId } }),
      );
      expect(left).toBe(0);
    });
  });
});
