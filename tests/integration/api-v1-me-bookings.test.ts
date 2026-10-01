import { NextRequest } from 'next/server';

import { GET as myBookings } from '@/app/api/v1/me/bookings/route';

import { signInAs, seedPlayer } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * GET /api/v1/me/bookings — the caller's own bookings at EVERY club.
 *
 * Needs a real database because what is being tested is a binding: `booking`
 * is tenant-scoped under RLS, and a wrong binding returns zero rows rather
 * than an error — an empty page that reads as "you have no bookings". Two
 * clubs, and a count, is the only way to tell those apart.
 */
const db = prismaTestClient();

interface Item {
  id: string;
  status: string;
  startTs: string;
  clubSlug: string | null;
  venue: { id: string; name: string; timezone: string };
  resource: { id: string; name: string; sport: string };
  venueReview: { id: string; bookingId: string | null; rating: number; status: string } | null;
  canReview: boolean;
}
interface PageBody {
  data: { items: Item[]; nextCursor: string | null };
}

const call = (query = '', headers: Record<string, string> = {}) =>
  myBookings(new NextRequest(`http://localhost:3000/api/v1/me/bookings${query}`, { headers }), {
    params: Promise.resolve({}),
  });

async function bearerFor(userId: string): Promise<string> {
  return (await signInAs(db, { userId, memberships: [] })).bearer;
}

async function book(
  resourceId: string,
  tenantId: string,
  userId: string,
  startTs: string,
  status: 'CONFIRMED' | 'COMPLETED' = 'CONFIRMED',
) {
  return asAppSuperuser(db, (tx) =>
    tx.booking.create({
      data: {
        tenantId,
        resourceId,
        startTs: new Date(startTs),
        endTs: new Date(new Date(startTs).getTime() + 3_600_000),
        bookedByUserId: userId,
        totalCents: 2400,
        status,
        idempotencyKey: `k-${Math.random()}`,
      },
      select: { id: true },
    }),
  );
}

describe('GET /api/v1/me/bookings', () => {
  let clubA: SeededTenant;
  let clubB: SeededTenant;
  let courtA: { venueId: string; venueSlug: string; resourceId: string };
  let courtB: { venueId: string; venueSlug: string; resourceId: string };
  let playerId: string;
  let bearer: string;

  beforeEach(async () => {
    clubA = await seedTenant({});
    clubB = await seedTenant({});
    courtA = await seedVenue(clubA.tenantId, { name: 'Club A Courts' });
    courtB = await seedVenue(clubB.tenantId, { name: 'Club B Courts' });
    playerId = await seedPlayer(db, clubA.tenantId);
    bearer = await bearerFor(playerId);
  });

  it('401s signed out', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('lists bookings at EVERY club, newest first, each with ITS club slug', async () => {
    const a = await book(courtA.resourceId, clubA.tenantId, playerId, '2026-07-15T06:00:00Z');
    const b = await book(courtB.resourceId, clubB.tenantId, playerId, '2026-07-16T06:00:00Z');

    const res = await call('', { authorization: `Bearer ${bearer}` });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as PageBody;

    expect(data.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(data.items.map((i) => i.clubSlug)).toEqual([clubB.tenantSlug, clubA.tenantSlug]);
    // The CLUB's slug, which the booking actions take — not the venue's.
    expect(data.items[0]!.clubSlug).not.toBe(courtB.venueSlug);
    expect(data.items[0]).toMatchObject({
      startTs: '2026-07-16T06:00:00Z',
      venue: { id: courtB.venueId, name: 'Club B Courts', timezone: 'Europe/Sofia' },
      resource: { id: courtB.resourceId, name: 'Court 1', sport: 'PADEL' },
      venueReview: null,
      canReview: false,
    });
    expect(data.nextCursor).toBeNull();
  });

  it("never lists somebody else's bookings", async () => {
    const stranger = await seedPlayer(db, clubA.tenantId, 'stranger');
    await book(courtA.resourceId, clubA.tenantId, stranger, '2026-07-15T06:00:00Z');

    const res = await call('', { authorization: `Bearer ${bearer}` });
    expect(((await res.json()) as PageBody).data).toEqual({ items: [], nextCursor: null });
  });

  it('pages by cursor, without repeating or skipping, to a null cursor', async () => {
    const ids: string[] = [];
    for (let day = 10; day < 15; day++) {
      const club = day % 2 ? clubA : clubB;
      const court = day % 2 ? courtA : courtB;
      ids.push(
        (await book(court.resourceId, club.tenantId, playerId, `2026-07-${day}T06:00:00Z`)).id,
      );
    }
    const newestFirst = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await call(q, { authorization: `Bearer ${bearer}` });
      const { data } = (await res.json()) as PageBody;
      expect(data.items.length).toBeLessThanOrEqual(2);
      seen.push(...data.items.map((i) => i.id));
      cursor = data.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toEqual(newestFirst);
    expect(pages).toBe(3);
  });

  it('clamps a nonsense limit to the default rather than refusing it', async () => {
    await book(courtA.resourceId, clubA.tenantId, playerId, '2026-07-15T06:00:00Z');
    for (const q of ['?limit=abc', '?limit=0', '?limit=-3']) {
      const res = await call(q, { authorization: `Bearer ${bearer}` });
      expect(res.status).toBe(200);
      expect(((await res.json()) as PageBody).data.items).toHaveLength(1);
    }
  });

  it('a cursor that names no booking is an empty last page, not an error', async () => {
    await book(courtA.resourceId, clubA.tenantId, playerId, '2026-07-15T06:00:00Z');
    const res = await call('?cursor=cnotabookingatall', { authorization: `Bearer ${bearer}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PageBody).data).toEqual({ items: [], nextCursor: null });
  });

  it('carries the review state: canReview on a COMPLETED booking, then the review once written', async () => {
    const done = await book(
      courtA.resourceId,
      clubA.tenantId,
      playerId,
      '2026-07-15T06:00:00Z',
      'COMPLETED',
    );

    const before = (
      (await (await call('', { authorization: `Bearer ${bearer}` })).json()) as PageBody
    ).data.items[0]!;
    expect(before).toMatchObject({ id: done.id, canReview: true, venueReview: null });

    const review = await asAppSuperuser(db, (tx) =>
      tx.review.create({
        data: {
          tenantId: clubA.tenantId,
          venueId: courtA.venueId,
          bookingId: done.id,
          authorUserId: playerId,
          rating: 4,
          status: 'PUBLISHED',
        },
        select: { id: true },
      }),
    );

    const after = (
      (await (await call('', { authorization: `Bearer ${bearer}` })).json()) as PageBody
    ).data.items[0]!;
    expect(after.canReview).toBe(false);
    expect(after.venueReview).toEqual({
      id: review.id,
      bookingId: done.id,
      rating: 4,
      status: 'PUBLISHED',
    });
  });

  it('409 VIEWER_CHANGED for a page rendered for another account (T15)', async () => {
    await book(courtA.resourceId, clubA.tenantId, playerId, '2026-07-15T06:00:00Z');
    const res = await call('', {
      authorization: `Bearer ${bearer}`,
      'x-playerz-viewer': 'cuser_someone_else',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string }; data?: unknown };
    expect(body.error.code).toBe('VIEWER_CHANGED');
    // Refused before the read: nothing of the booking list rides along.
    expect(body.data).toBeUndefined();
  });
});
