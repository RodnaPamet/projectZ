import { NextRequest } from 'next/server';

import { GET as detailRoute } from '@/app/api/v1/me/bookings/[id]/route';
import { GET as listRoute } from '@/app/api/v1/me/bookings/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * #359: one booking in full (`GET /api/v1/me/bookings/{id}`), the Предстоящи
 * and Минали split (`?when=`), and cancelling from the detail screen before
 * and after the venue's cutoff.
 *
 * A real database, because the thing under test is a binding: `booking` is
 * tenant-scoped under RLS, and the detail read spans clubs. An IDOR here would
 * not error, it would quietly return somebody else's booking, so each "not
 * yours" case asserts the 404 AND that nothing of the booking leaked.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;

interface ApiError {
  error: { code: string; details?: { field?: string } };
}
interface Detail {
  id: string;
  status: string;
  clubSlug: string | null;
  cancellableUntil: string | null;
  payAtClub: boolean;
  venue: Record<string, unknown>;
  players: Array<Record<string, unknown>>;
}
interface Page {
  data: { items: Array<{ id: string; status: string }>; nextCursor: string | null };
}

const auth = (who: TestIdentity) => ({ authorization: `Bearer ${who.bearer}` });

const detail = async (who: TestIdentity | null, id: string) => {
  const res = await detailRoute(
    new NextRequest(`http://localhost:3000/api/v1/me/bookings/${id}`, {
      headers: who ? auth(who) : {},
    }),
    { params: Promise.resolve({ id }) },
  );
  return { res, body: (await res.json()) as { data: Detail } & ApiError };
};

const list = async (who: TestIdentity, query: string) => {
  const res = await listRoute(
    new NextRequest(`http://localhost:3000/api/v1/me/bookings${query}`, { headers: auth(who) }),
    { params: Promise.resolve({}) },
  );
  return { res, body: (await res.json()) as Page & ApiError };
};

describe('GET /api/v1/me/bookings/{id}, ?when=, and cancel (#359)', () => {
  let club: SeededTenant;
  let otherClub: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let otherCourt: { venueId: string; venueSlug: string; resourceId: string };
  let player: TestIdentity;
  let rival: TestIdentity;

  const book = (
    who: TestIdentity,
    startsInHours: number,
    opts: { status?: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'; at?: 'club' | 'other' } = {},
  ) => {
    const at = opts.at === 'other' ? otherClub : club;
    const c = opts.at === 'other' ? otherCourt : court;
    const start = new Date(Date.now() + startsInHours * HOUR);
    return asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: at.tenantId,
          resourceId: c.resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: who.userId,
          totalCents: 2400,
          status: opts.status ?? 'CONFIRMED',
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      }),
    ).then((b) => b.id);
  };

  const cancel = async (who: TestIdentity, slug: string, id: string) => {
    const res = await cancelRoute(
      new NextRequest(`http://localhost:3000/api/v1/t/${slug}/bookings/${id}/cancel`, {
        method: 'POST',
        headers: auth(who),
      }),
      { params: Promise.resolve({ slug, id }) },
    );
    return { res, body: (await res.json()) as ApiError };
  };

  beforeEach(async () => {
    club = await seedTenant({});
    otherClub = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    otherCourt = await seedVenue(otherClub.tenantId, { name: 'Бета Кортове' });

    const playerId = await seedPlayer(db, club.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
    const rivalId = await seedPlayer(db, club.tenantId, 'rival');
    rival = await signInAs(db, {
      userId: rivalId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  });

  describe('the detail', () => {
    it('401s signed out', async () => {
      const id = await book(player, 48);
      const { res, body } = await detail(null, id);
      expect(res.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns the booking in full: venue address and coordinates, pay at the club, the booker', async () => {
      await asAppSuperuser(db, (tx) =>
        tx.venue.update({
          where: { id: court.venueId },
          data: { phone: '+359 2 123 4567', cancellationCutoffHours: 12 },
        }),
      );
      const id = await book(player, 48);

      const { res, body } = await detail(player, id);
      expect(res.status).toBe(200);
      const d = body.data;

      expect(d).toMatchObject({
        id,
        status: 'CONFIRMED',
        clubSlug: club.tenantSlug,
        payAtClub: true,
        venueReview: null,
        canReview: false,
        resource: { id: court.resourceId, sport: 'PADEL' },
      });
      expect(d.venue).toMatchObject({
        id: court.venueId,
        name: 'Алфа Кортове',
        timezone: 'Europe/Sofia',
        phone: '+359 2 123 4567',
      });
      expect(typeof d.venue.addressLine).toBe('string');
      expect(typeof d.venue.city).toBe('string');
      // Numbers, not Decimal strings: a Swift `Double` would fail to decode.
      expect(typeof d.venue.lat).toBe('number');
      expect(typeof d.venue.lng).toBe('number');
      expect(d.venue).toHaveProperty('publicSlug');

      // The venue's 12 h cutoff, before the start, with no fractional seconds.
      const start = Date.parse((body.data as unknown as { startTs: string }).startTs);
      expect(Date.parse(d.cancellableUntil!)).toBe(start - 12 * HOUR);
      expect(d.cancellableUntil).toMatch(/:\d\dZ$/);

      // The booker alone, nobody added yet (#358): a name and a face, nothing
      // else. No user id: the booker is not a participant row, so no id at all.
      expect(d.players).toEqual([
        {
          participantId: null,
          name: 'Test Player',
          avatarUrl: null,
          isBooker: true,
          isYou: true,
          registered: true,
          deleted: false,
        },
      ]);
      expect(JSON.stringify(d)).not.toMatch(/@playerz\.test/);
      expect(JSON.stringify(d)).not.toContain(club.tenantId);
    });

    it("is a 404 for somebody else's booking, and leaks nothing of it", async () => {
      const theirs = await book(rival, 48);

      const { res, body } = await detail(player, theirs);
      expect(res.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain('Алфа');
      expect(body).not.toHaveProperty('data');
    });

    it('is the SAME 404 for an id that never existed, or is not even an id', async () => {
      for (const id of ['cl0000000000000000000000000', 'not-an-id', "'; DROP TABLE booking;--"]) {
        const { res, body } = await detail(player, encodeURIComponent(id));
        expect(res.status).toBe(404);
        expect(body.error.code).toBe('NOT_FOUND');
      }
    });

    it("finds the caller's booking at ANY club, including one in the token's memberships it is not", async () => {
      const id = await book(player, 48, { at: 'other' });
      const { res, body } = await detail(player, id);
      expect(res.status).toBe(200);
      expect(body.data.clubSlug).toBe(otherClub.tenantSlug);
      expect(body.data.venue.name).toBe('Бета Кортове');
    });

    it('a cancelled booking is not cancellable: no deadline', async () => {
      const id = await book(player, 48, { status: 'CANCELLED' });
      const { body } = await detail(player, id);
      expect(body.data.status).toBe('CANCELLED');
      expect(body.data.cancellableUntil).toBeNull();
    });
  });

  describe('?when=upcoming|past', () => {
    it('splits by "still to be played", soonest first above, newest first below', async () => {
      const later = await book(player, 72);
      const soon = await book(player, 2);
      const inProgress = await book(player, -0.5); // started 30 min ago, ends in 30
      const cancelledFuture = await book(player, 24, { status: 'CANCELLED' });
      const played = await book(player, -48, { status: 'COMPLETED' });
      const lapsed = await book(player, -24); // CONFIRMED, but over
      await book(rival, 5); // never anybody else's

      const up = await list(player, '?when=upcoming');
      expect(up.res.status).toBe(200);
      expect(up.body.data.items.map((i) => i.id)).toEqual([inProgress, soon, later]);

      const past = await list(player, '?when=past');
      expect(past.body.data.items.map((i) => i.id)).toEqual([cancelledFuture, lapsed, played]);

      // Without `when`: every one of them, newest first, as before #359.
      const all = await list(player, '');
      expect(all.body.data.items).toHaveLength(6);
      expect(all.body.data.items[0]!.id).toBe(later);
    });

    it('pages each tab by cursor without repeats', async () => {
      const ids = [];
      for (let h = 10; h <= 50; h += 10) ids.push(await book(player, h));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const q: string = `?when=upcoming&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const { body } = await list(player, q);
        seen.push(...body.data.items.map((i) => i.id));
        cursor = body.data.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
    });

    it('refuses any other value, naming the field', async () => {
      for (const q of ['?when=future', '?when=', '?when=UPCOMING']) {
        const { res, body } = await list(player, q);
        expect(res.status).toBe(400);
        expect(body.error.code).toBe('BAD_REQUEST');
        expect(body.error.details?.field).toBe('when');
      }
    });
  });

  describe('cancelling from the detail screen', () => {
    it('before the cutoff: cancelled, and it moves from Предстоящи to Минали', async () => {
      const id = await book(player, 48);
      const before = await detail(player, id);
      expect(Date.parse(before.body.data.cancellableUntil!)).toBeGreaterThan(Date.now());

      const { res } = await cancel(player, before.body.data.clubSlug!, id);
      expect(res.status).toBe(200);

      const after = await detail(player, id);
      expect(after.body.data.status).toBe('CANCELLED');
      expect(after.body.data.cancellableUntil).toBeNull();

      expect((await list(player, '?when=upcoming')).body.data.items).toEqual([]);
      expect((await list(player, '?when=past')).body.data.items.map((i) => i.id)).toEqual([id]);
    });

    it('after the cutoff: the detail says so, and the cancel route agrees with 403', async () => {
      const id = await book(player, 3); // the default 24 h cutoff passed 21 h ago
      const { body } = await detail(player, id);
      expect(Date.parse(body.data.cancellableUntil!)).toBeLessThan(Date.now());

      const refused = await cancel(player, club.tenantSlug, id);
      expect(refused.res.status).toBe(403);
      expect(refused.body.error.code).toBe('CANCELLATION_CUTOFF_PASSED');
      expect((await detail(player, id)).body.data.status).toBe('CONFIRMED');
    });

    it("cannot cancel somebody else's booking through the club route: 404", async () => {
      const theirs = await book(rival, 48);
      const { res } = await cancel(player, club.tenantSlug, theirs);
      expect(res.status).toBe(404);
      const row = await asAppSuperuser(db, (tx) =>
        tx.booking.findUniqueOrThrow({ where: { id: theirs } }),
      );
      expect(row.status).toBe('CONFIRMED');
    });
  });
});
