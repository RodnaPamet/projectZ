import { NextRequest } from 'next/server';

import { POST as acceptRoute } from '@/app/api/v1/booking-invites/accept/route';
import { POST as previewRoute } from '@/app/api/v1/booking-invites/preview/route';
import { GET as coPlayersRoute } from '@/app/api/v1/me/bookings/[id]/co-players/route';
import { DELETE as revokeOneRoute } from '@/app/api/v1/me/bookings/[id]/invite-links/[linkId]/route';
import {
  DELETE as revokeAllRoute,
  POST as createLinkRoute,
} from '@/app/api/v1/me/bookings/[id]/invite-links/route';
import { DELETE as removeRoute } from '@/app/api/v1/me/bookings/[id]/participants/[participantId]/route';
import {
  GET as participantsRoute,
  POST as addRoute,
} from '@/app/api/v1/me/bookings/[id]/participants/route';
import { DELETE as leaveRoute } from '@/app/api/v1/me/bookings/[id]/participation/route';
import { GET as detailRoute } from '@/app/api/v1/me/bookings/[id]/route';
import { GET as listRoute } from '@/app/api/v1/me/bookings/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { acceptBookingInvite } from '@/app-layer/usecases/booking-players';
import { hashForLookup } from '@/lib/security/encryption';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * #358: the booker adds players, by invite link or from people they played
 * with, up to the court's capacity. A real database, because what is under
 * test is mostly bindings and races: the token lookup crosses clubs, the
 * writes run under RLS in the booking's club, and two people taking the last
 * place at once must not both get it.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const BASE = 'http://localhost:3000/api/v1';

interface ApiError {
  error: { code: string; details?: { field?: string } };
}
interface Player {
  participantId: string | null;
  name: string | null;
  avatarUrl: string | null;
  isBooker: boolean;
  isYou: boolean;
  registered: boolean;
}
interface Participants {
  viewerRole: string;
  capacity: number;
  spotsLeft: number;
  playersOpen: boolean;
  liveInviteLinks: number | null;
  players: Player[];
}
interface Link {
  id: string;
  token: string;
  url: string;
  expiresAt: string;
}

const auth = (who: TestIdentity | null): Record<string, string> =>
  who ? { authorization: `Bearer ${who.bearer}` } : {};

async function call<T>(
  route: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  who: TestIdentity | null,
  path: string,
  init: { method?: string; body?: unknown; params?: Record<string, string>; ip?: string } = {},
) {
  const res = await route(
    new NextRequest(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...auth(who),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.ip ? { 'x-forwarded-for': init.ip } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    { params: Promise.resolve(init.params ?? {}) },
  );
  const text = await res.text();
  return { res, body: (text ? JSON.parse(text) : {}) as { data: T } & ApiError };
}

type AnyRoute = Parameters<typeof call>[0];
const r = (fn: unknown) => fn as AnyRoute;

describe('players on a booking (#358)', () => {
  let club: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let booker: TestIdentity;
  let friend: TestIdentity;
  let second: TestIdentity;
  let stranger: TestIdentity;

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

  const book = (
    who: TestIdentity,
    startsInHours: number,
    status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' = 'CONFIRMED',
  ) => {
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
          status,
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      }),
    ).then((b) => b.id);
  };

  const setCapacity = (capacity: number) =>
    asAppSuperuser(db, (tx) =>
      tx.resource.update({ where: { id: court.resourceId }, data: { capacity } }),
    );

  const createLink = (who: TestIdentity, id: string) =>
    call<Link>(r(createLinkRoute), who, `/me/bookings/${id}/invite-links`, {
      method: 'POST',
      params: { id },
    });
  const accept = (who: TestIdentity | null, token: string) =>
    call<{ bookingId: string; joined: boolean }>(r(acceptRoute), who, '/booking-invites/accept', {
      method: 'POST',
      body: { token },
    });
  const preview = (token: string, ip?: string) =>
    call<Record<string, unknown>>(r(previewRoute), null, '/booking-invites/preview', {
      method: 'POST',
      body: { token },
      ...(ip ? { ip } : {}),
    });
  const participants = (who: TestIdentity, id: string) =>
    call<Participants>(r(participantsRoute), who, `/me/bookings/${id}/participants`, {
      params: { id },
    });
  const auditActions = async (action: string) =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: club.tenantId, action } }),
    );

  beforeEach(async () => {
    club = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    booker = await person('booker', 'Иван Петров');
    friend = await person('friend', 'Мария Георгиева');
    second = await person('second', 'Петър Иванов');
    stranger = await person('stranger', 'Чужд Човек');
  });

  describe('invite links', () => {
    it('creates a link valid until the start, and stores only an HMAC of the token', async () => {
      const id = await book(booker, 48);
      const { res, body } = await createLink(booker, id);

      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const link = body.data;
      // 32 random bytes, base64url: not guessable.
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(link.url).toMatch(new RegExp(`/invite/booking/${link.token}$`));

      const rows = await asAppSuperuser(db, (tx) => tx.bookingInviteLink.findMany({}));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(hashForLookup(link.token));
      expect(rows[0]!.tokenHash).not.toContain(link.token);
      expect(JSON.stringify(rows)).not.toContain(link.token);
      const booking = await asAppSuperuser(db, (tx) =>
        tx.booking.findUniqueOrThrow({ where: { id } }),
      );
      expect(rows[0]!.expiresAt.getTime()).toBe(booking.startTs.getTime());

      // The audit row records the link, never the token.
      const audit = await auditActions('BOOKING_INVITE_LINK_CREATED');
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(link.token);
    });

    it('two links are two different tokens', async () => {
      const id = await book(booker, 48);
      const a = (await createLink(booker, id)).body.data.token;
      const b = (await createLink(booker, id)).body.data.token;
      expect(a).not.toBe(b);
    });

    it('refuses a link to a stranger (404) and to an added player (403 BOOKER_ONLY)', async () => {
      const id = await book(booker, 48);
      expect((await createLink(stranger, id)).res.status).toBe(404);

      const token = (await createLink(booker, id)).body.data.token;
      await accept(friend, token);
      const { res, body } = await createLink(friend, id);
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('BOOKER_ONLY');
    });

    it('previews the game with nothing private', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;

      const { res, body } = await preview(token);
      expect(res.status).toBe(200);
      expect(body.data).toMatchObject({
        venue: { name: 'Алфа Кортове' },
        bookerFirstName: 'Иван',
        capacity: 4,
        spotsLeft: 3,
      });
      const wire = JSON.stringify(body.data);
      expect(wire).not.toContain('Петров');
      expect(wire).not.toContain('@playerz.test');
      expect(wire).not.toContain(id);
      expect(wire).not.toContain('2400');
    });

    it('answers every unusable token the same 404', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      const bogus = 'A'.repeat(43);

      for (const t of [bogus, 'short', `${token}x`]) {
        const { res, body } = await preview(t);
        expect(res.status).toBe(404);
        expect(body.error.code).toBe('BOOKING_INVITE_NOT_USABLE');
      }
    });
  });

  describe('accepting', () => {
    it('adds the person who opens it, who then sees the booking in /me/bookings', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;

      const { res, body } = await accept(friend, token);
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ bookingId: id, joined: true });

      const list = await call<{
        items: Array<{ id: string; viewerRole: string; cancellableUntil: string | null }>;
      }>(r(listRoute), friend, '/me/bookings?when=upcoming');
      expect(list.body.data.items.map((b) => b.id)).toEqual([id]);
      expect(list.body.data.items[0]).toMatchObject({
        viewerRole: 'PARTICIPANT',
        cancellableUntil: null,
      });

      const detail = await call<{ viewerRole: string; players: Player[]; spotsLeft: number }>(
        r(detailRoute),
        friend,
        `/me/bookings/${id}`,
        { params: { id } },
      );
      expect(detail.res.status).toBe(200);
      expect(detail.body.data.viewerRole).toBe('PARTICIPANT');
      expect(detail.body.data.spotsLeft).toBe(2);
      expect(detail.body.data.players.map((p) => [p.name, p.isBooker, p.isYou])).toEqual([
        ['Иван Петров', true, false],
        ['Мария Георгиева', false, true],
      ]);

      // The booker still sees it as theirs.
      const mine = await call<{ viewerRole: string }>(
        r(detailRoute),
        booker,
        `/me/bookings/${id}`,
        {
          params: { id },
        },
      );
      expect(mine.body.data.viewerRole).toBe('BOOKER');
    });

    it('is harmless twice, and for the booker', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);

      expect((await accept(friend, token)).body.data).toEqual({ bookingId: id, joined: false });
      expect((await accept(booker, token)).body.data).toEqual({ bookingId: id, joined: false });
      expect((await participants(booker, id)).body.data.players).toHaveLength(2);
    });

    it('needs a session', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      expect((await accept(null, token)).res.status).toBe(401);
    });

    it('refuses once the court is full (409 BOOKING_FULL)', async () => {
      await setCapacity(2);
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;

      expect((await accept(friend, token)).res.status).toBe(200);
      const { res, body } = await accept(second, token);
      expect(res.status).toBe(409);
      expect(body.error.code).toBe('BOOKING_FULL');
    });

    it('gives the last place to exactly one of two people accepting at once', async () => {
      await setCapacity(2);
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;

      const results = await Promise.allSettled([
        acceptBookingInvite({ userId: friend.userId, token }),
        acceptBookingInvite({ userId: second.userId, token }),
      ]);
      const ok = results.filter((x) => x.status === 'fulfilled');
      const refused = results.filter((x) => x.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(((refused[0] as PromiseRejectedResult).reason as Error).name).toBe('BookingFullError');

      const rows = await asAppSuperuser(db, (tx) =>
        tx.bookingParticipant.findMany({ where: { bookingId: id } }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.position).toBe(2);
    });

    it('stops working at the start of the game', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      // The game has started: the link expired with it.
      await asAppSuperuser(db, (tx) =>
        tx.bookingInviteLink.updateMany({
          where: { bookingId: id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        }),
      );
      const { res, body } = await accept(friend, token);
      expect(res.status).toBe(404);
      expect(body.error.code).toBe('BOOKING_INVITE_NOT_USABLE');
    });

    it('stops working when the booking is cancelled, for everyone', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);

      const cancelled = await call<unknown>(
        r(cancelRoute),
        booker,
        `/t/${club.tenantSlug}/bookings/${id}/cancel`,
        { method: 'POST', params: { slug: club.tenantSlug, id } },
      );
      expect(cancelled.res.status).toBe(200);

      expect((await accept(second, token)).res.status).toBe(404);
      // The added player sees it cancelled, under Минали.
      const past = await call<{ items: Array<{ id: string; status: string }> }>(
        r(listRoute),
        friend,
        '/me/bookings?when=past',
      );
      expect(past.body.data.items).toEqual([expect.objectContaining({ id, status: 'CANCELLED' })]);
      // ...and cannot cancel it themselves: only the booker's booking is found.
      const theirs = await call<unknown>(
        r(cancelRoute),
        friend,
        `/t/${club.tenantSlug}/bookings/${id}/cancel`,
        { method: 'POST', params: { slug: club.tenantSlug, id } },
      );
      expect(theirs.res.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses a club account, and asks an undecided one to choose first', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;

      await asAppSuperuser(db, (tx) =>
        tx.user.update({ where: { id: second.userId }, data: { accountKind: null } }),
      );
      const undecided = await accept(second, token);
      expect(undecided.res.status).toBe(403);
      expect(undecided.body.error.code).toBe('ACCOUNT_KIND_REQUIRED');

      const clubAccount = await signInAs(db, { userId: club.userId, memberships: [] });
      const refused = await accept(clubAccount, token);
      expect(refused.res.status).toBe(403);
      expect(refused.body.error.code).toBe('PLAYER_ACCOUNT_REQUIRED');
    });
  });

  describe('revoking, leaving and removing', () => {
    it('a revoked link stops working; the players already added stay; audited', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);

      const { res, body } = await call<{ revoked: number }>(
        r(revokeAllRoute),
        booker,
        `/me/bookings/${id}/invite-links`,
        { method: 'DELETE', params: { id } },
      );
      expect(res.status).toBe(200);
      expect(body.data.revoked).toBe(1);

      expect((await accept(second, token)).res.status).toBe(404);
      expect((await preview(token)).res.status).toBe(404);
      expect((await participants(booker, id)).body.data.players).toHaveLength(2);
      expect(await auditActions('BOOKING_INVITE_LINK_REVOKED')).toHaveLength(1);
    });

    it('revokes one link by id, leaving the others', async () => {
      const id = await book(booker, 48);
      const a = (await createLink(booker, id)).body.data;
      const b = (await createLink(booker, id)).body.data;

      const { body } = await call<{ revoked: number }>(
        r(revokeOneRoute),
        booker,
        `/me/bookings/${id}/invite-links/${a.id}`,
        { method: 'DELETE', params: { id, linkId: a.id } },
      );
      expect(body.data.revoked).toBe(1);
      expect((await preview(a.token)).res.status).toBe(404);
      expect((await preview(b.token)).res.status).toBe(200);
      expect((await participants(booker, id)).body.data.liveInviteLinks).toBe(1);
    });

    it('an added player leaves; the booking drops from their list; the booker cannot "leave"', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);

      const left = await call<unknown>(r(leaveRoute), friend, `/me/bookings/${id}/participation`, {
        method: 'DELETE',
        params: { id },
      });
      expect(left.res.status).toBe(204);
      const list = await call<{ items: unknown[] }>(r(listRoute), friend, '/me/bookings');
      expect(list.body.data.items).toEqual([]);
      expect(await auditActions('BOOKING_PLAYER_LEFT')).toHaveLength(1);

      const own = await call<unknown>(r(leaveRoute), booker, `/me/bookings/${id}/participation`, {
        method: 'DELETE',
        params: { id },
      });
      expect(own.res.status).toBe(409);
      expect(own.body.error.code).toBe('BOOKER_CANNOT_LEAVE');
    });

    it('the booker removes a player; audited; only the booker may', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);
      await accept(second, token);
      const before = (await participants(booker, id)).body.data.players;
      const target = before.find((p) => p.name === 'Петър Иванов')!;

      const byFriend = await call<unknown>(
        r(removeRoute),
        friend,
        `/me/bookings/${id}/participants/${target.participantId}`,
        { method: 'DELETE', params: { id, participantId: target.participantId! } },
      );
      expect(byFriend.res.status).toBe(403);

      const removed = await call<unknown>(
        r(removeRoute),
        booker,
        `/me/bookings/${id}/participants/${target.participantId}`,
        { method: 'DELETE', params: { id, participantId: target.participantId! } },
      );
      expect(removed.res.status).toBe(204);
      const after = (await participants(booker, id)).body.data.players;
      expect(after.map((p) => p.name)).toEqual(['Иван Петров', 'Мария Георгиева']);
      const audit = await auditActions('BOOKING_PLAYER_REMOVED');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorUserId).toBe(booker.userId);

      // Gone from the removed player's list.
      const theirs = await call<{ items: unknown[] }>(r(listRoute), second, '/me/bookings');
      expect(theirs.body.data.items).toEqual([]);
    });

    it('nothing changes once the game has started', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({
          where: { id },
          data: { startTs: new Date(Date.now() - HOUR), endTs: new Date(Date.now() + HOUR) },
        }),
      );
      const left = await call<unknown>(r(leaveRoute), friend, `/me/bookings/${id}/participation`, {
        method: 'DELETE',
        params: { id },
      });
      expect(left.res.status).toBe(409);
      expect(left.body.error.code).toBe('BOOKING_PLAYERS_CLOSED');
    });
  });

  describe('who can see the players (IDOR)', () => {
    it('a stranger gets the same 404 as for an id that never existed, and no names', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);

      const theirs = await participants(stranger, id);
      const none = await participants(stranger, 'c000000000000000000000000');
      expect(theirs.res.status).toBe(404);
      expect(none.res.status).toBe(404);
      expect(theirs.body.error.code).toBe(none.body.error.code);
      expect(JSON.stringify(theirs.body)).not.toContain('Мария');
    });

    it('a participant sees names and avatars only: no emails, no user ids', async () => {
      const id = await book(booker, 48);
      const { token } = (await createLink(booker, id)).body.data;
      await accept(friend, token);
      await accept(second, token);

      const { res, body } = await participants(friend, id);
      expect(res.status).toBe(200);
      expect(body.data.viewerRole).toBe('PARTICIPANT');
      expect(body.data.liveInviteLinks).toBeNull();
      const wire = JSON.stringify(body.data);
      expect(wire).not.toContain('@playerz.test');
      for (const who of [booker, friend, second]) expect(wire).not.toContain(who.userId);
    });
  });

  describe('adding somebody you have played with', () => {
    it('offers co-players from past games, and adds only them', async () => {
      // A past game with Мария.
      const past = await book(booker, -72, 'COMPLETED');
      await asAppSuperuser(db, (tx) =>
        tx.bookingParticipant.create({
          data: { tenantId: club.tenantId, bookingId: past, userId: friend.userId, position: 2 },
        }),
      );
      const id = await book(booker, 48);

      const { res, body } = await call<Array<{ userId: string; name: string }>>(
        r(coPlayersRoute),
        booker,
        `/me/bookings/${id}/co-players`,
        { params: { id } },
      );
      expect(res.status).toBe(200);
      expect(body.data).toEqual([
        { userId: friend.userId, name: 'Мария Георгиева', avatarUrl: null },
      ]);

      const added = await call<Participants>(
        r(addRoute),
        booker,
        `/me/bookings/${id}/participants`,
        {
          method: 'POST',
          body: { userId: friend.userId },
          params: { id },
        },
      );
      expect(added.res.status).toBe(201);
      expect(added.body.data.players.map((p) => p.name)).toContain('Мария Георгиева');

      // A stranger's id is not a co-player: nobody is put on a booking by id.
      const refused = await call<unknown>(r(addRoute), booker, `/me/bookings/${id}/participants`, {
        method: 'POST',
        body: { userId: stranger.userId },
        params: { id },
      });
      expect(refused.res.status).toBe(404);
      expect(refused.body.error.code).toBe('PLAYER_NOT_FOUND');

      // An unknown body key is a 400 naming it.
      const strict = await call<unknown>(r(addRoute), booker, `/me/bookings/${id}/participants`, {
        method: 'POST',
        body: { userId: friend.userId, position: 1 },
        params: { id },
      });
      expect(strict.res.status).toBe(400);
      expect(strict.body.error.details?.field).toBe('position');
    });
  });

  describe('rate limit', () => {
    const saved = process.env.RATE_LIMIT_ENABLED;
    afterEach(() => {
      process.env.RATE_LIMIT_ENABLED = saved;
    });

    it('limits preview and accept to 10 a minute per IP', async () => {
      process.env.RATE_LIMIT_ENABLED = '1';
      const ip = `10.58.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await preview('B'.repeat(43), ip)).res.status);
      expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});
