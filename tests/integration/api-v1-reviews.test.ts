import type { BookingStatus } from '@prisma/client';
import { NextRequest } from 'next/server';

import { POST as reviewRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/review/route';
import { completeEndedBookings, markNoShow } from '@/app-layer/usecases/booking-outcome';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { findRequest, setModerationScores, useMswServer } from '../helpers/msw';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * The review write path, through the v1 route, against a real database.
 *
 * This is the entry point the native client calls, so the proof of visit is
 * proved HERE and not only in the use case: a real bearer token through
 * `getToken` + `checkSession`, the club resolved from the database, RLS bound
 * to it, and the classifier reached through MSW — never for real.
 */

const HOUR = 3_600_000;

const db = prismaTestClient();

useMswServer();

let tenant: SeededTenant;
let venueId: string;
let playerId: string;
let player: TestIdentity;

type ReviewBody = {
  data: {
    id: string;
    bookingId: string;
    venueId: string;
    rating: number;
    body: string | null;
    status: string;
    createdAt: string;
  };
};
type ApiError = { error: { code: string; message: string } };

beforeEach(async () => {
  tenant = await seedTenant();
  venueId = await asAppSuperuser(db, (tx) =>
    tx.venue
      .create({
        data: {
          tenantId: tenant.tenantId,
          slug: `review-club-${Math.random().toString(36).slice(2, 10)}`,
          name: 'Review Club',
          addressLine: '1 Court St',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: 'desk@club.test',
        },
      })
      .then((v) => v.id),
  );
  playerId = await seedPlayer(db, tenant.tenantId);
  player = await signInAs(db, {
    userId: playerId,
    memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
  });
});

async function seedBooking(
  opts: { status?: BookingStatus; userId?: string; endedH?: number } = {},
) {
  return asAppSuperuser(db, async (tx) => {
    const court = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId,
        name: 'Court',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    const endedH = opts.endedH ?? 1;
    return tx.booking.create({
      data: {
        tenantId: tenant.tenantId,
        resourceId: court.id,
        startTs: new Date(Date.now() - (endedH + 1) * HOUR),
        endTs: new Date(Date.now() - endedH * HOUR),
        bookedByUserId: opts.userId ?? playerId,
        status: opts.status ?? 'COMPLETED',
        totalCents: 2400,
        idempotencyKey: `rv-${Math.random().toString(36).slice(2, 12)}`,
      },
    });
  });
}

async function post(
  bookingId: string,
  body: unknown,
  opts: { who?: TestIdentity | null; slug?: string; raw?: string } = {},
) {
  const who = opts.who === undefined ? player : opts.who;
  const slug = opts.slug ?? tenant.tenantSlug;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${who.bearer}`;

  const res = await reviewRoute(
    new NextRequest(`http://t/api/v1/t/${slug}/bookings/${bookingId}/review`, {
      method: 'POST',
      headers,
      body: opts.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug, id: bookingId }) },
  );
  return { status: res.status, json: (await res.json()) as unknown };
}

const venueScore = () =>
  asAppSuperuser(db, (tx) =>
    tx.venue.findUniqueOrThrow({
      where: { id: venueId },
      select: { avgRating: true, reviewCount: true },
    }),
  ).then((v) => ({ avgRating: Number(v.avgRating), reviewCount: v.reviewCount }));

const code = (json: unknown) => (json as ApiError).error.code;

// ══ It works ═════════════════════════════════════════════════════════

describe('POST /api/v1/t/:slug/bookings/:id/review', () => {
  it('publishes a star-only review at once, and the venue list moves', async () => {
    const booking = await seedBooking();

    const { status, json } = await post(booking.id, { rating: 5 });

    expect(status).toBe(201);
    const { data } = json as ReviewBody;
    expect(data).toMatchObject({
      bookingId: booking.id,
      venueId,
      rating: 5,
      body: null,
      status: 'PUBLISHED',
    });
    // RFC 3339 with NO fractional seconds — Swift's default decoder rejects them.
    expect(data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Nothing the author should not see: no scores, no author id.
    expect(Object.keys(data).sort()).toEqual(
      ['body', 'bookingId', 'createdAt', 'id', 'rating', 'status', 'venueId'].sort(),
    );

    expect(await venueScore()).toEqual({ avgRating: 4.1, reviewCount: 1 });
  });

  it('sends text through the classifier, and a clean verdict publishes', async () => {
    const booking = await seedBooking();

    const { status, json } = await post(booking.id, {
      rating: 4,
      body: 'Great courts, friendly desk.',
    });

    expect(status).toBe(201);
    expect((json as ReviewBody).data.status).toBe('PUBLISHED');
    // MSW, not the real API: the request was intercepted and carried the text.
    const call = findRequest('api.anthropic.com/v1/messages');
    expect(JSON.stringify(call?.body)).toContain('Great courts, friendly desk.');
  });

  it('holds flagged text for a moderator: 201, PENDING_REVIEW, a case, and no score change', async () => {
    setModerationScores({ harassment: 0.7 });
    const booking = await seedBooking();

    const { status, json } = await post(booking.id, { rating: 1, body: 'something flagged' });

    expect(status).toBe(201);
    const { data } = json as ReviewBody;
    expect(data.status).toBe('PENDING_REVIEW');
    const c = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.findFirstOrThrow({ where: { subjectType: 'REVIEW', subjectId: data.id } }),
    );
    expect(c).toMatchObject({ status: 'OPEN', reason: 'harassment', tenantId: tenant.tenantId });
    expect(await venueScore()).toEqual({ avgRating: 0, reviewCount: 0 });
  });

  it('resolves the club from the DATABASE, not the token', async () => {
    // A token whose membership list lacks the club — truncated, or minted
    // before the player joined by booking. The handler must not read that as
    // "not a member"; the membership row decides.
    const tokenWithoutTheClub = await signInAs(db, { userId: playerId, memberships: [] });
    const booking = await seedBooking();

    const { status } = await post(booking.id, { rating: 5 }, { who: tokenWithoutTheClub });

    expect(status).toBe(201);
  });
});

// ══ Proof of visit, through the route ════════════════════════════════

describe('proof of visit, through the route', () => {
  it('an ended CONFIRMED booking is refused until the completion sweep has run', async () => {
    // The sweep is what makes a booking reviewable at all — nothing else ever
    // sets COMPLETED.
    const booking = await seedBooking({ status: 'CONFIRMED' });

    const before = await post(booking.id, { rating: 5 });
    expect(before.status).toBe(403);
    expect(code(before.json)).toBe('NO_PROOF_OF_VISIT');

    await asAppSuperuser(db, (tx) => completeEndedBookings(tx));

    const after = await post(booking.id, { rating: 5 });
    expect(after.status).toBe(201);
  });

  it('a booking staff marked as a no-show can never be reviewed', async () => {
    const booking = await seedBooking();
    await asAppUser(db, tenant.tenantId, (tx) =>
      markNoShow(tx, tenant.tenantId, { bookingId: booking.id, actorUserId: tenant.userId }),
    );

    const { status, json } = await post(booking.id, { rating: 1, body: 'I was there!' });

    expect(status).toBe(403);
    expect(code(json)).toBe('NO_PROOF_OF_VISIT');
    // Refused before the classifier: no call to pay for.
    expect(findRequest('api.anthropic.com')).toBeUndefined();
  });

  it("refuses somebody else's booking with the SAME answer as a missing one", async () => {
    const otherPlayer = await seedPlayer(db, tenant.tenantId, 'other');
    const theirs = await seedBooking({ userId: otherPlayer });

    const stolen = await post(theirs.id, { rating: 1 });
    const missing = await post('cl_no_such_booking_000000', { rating: 1 });

    // Indistinguishable on purpose — otherwise this is a way to learn which
    // bookings exist.
    expect(stolen.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(code(stolen.json)).toBe(code(missing.json));
  });

  it('refuses a second completed visit to the same venue: 409 ALREADY_REVIEWED', async () => {
    const first = await seedBooking();
    const second = await seedBooking();
    await post(first.id, { rating: 5 });

    const { status, json } = await post(second.id, { rating: 2 });

    expect(status).toBe(409);
    expect(code(json)).toBe('ALREADY_REVIEWED');
    expect(await venueScore()).toEqual({ avgRating: 4.1, reviewCount: 1 });
  });
});

// ══ The request itself ═══════════════════════════════════════════════

describe('what the route refuses before touching anything', () => {
  it('401 without a token', async () => {
    const booking = await seedBooking();

    const { status } = await post(booking.id, { rating: 5 }, { who: null });

    expect(status).toBe(401);
  });

  it('refuses a club that does not exist and a suspended member IDENTICALLY', async () => {
    // Both have no ACTIVE membership at the slug, so `contextFromRequest`
    // refuses both before the handler runs — the route needs `bookings.create`,
    // checked against the database since #250. This was a 404 from the handler
    // only when the edge was skipped; through the edge on main it was the
    // edge's 403, which is what it is again, now from the route.
    const booking = await seedBooking();

    const unknown = await post(booking.id, { rating: 5 }, { slug: 'no-such-club' });

    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.update({
        where: { userId_tenantId: { userId: playerId, tenantId: tenant.tenantId } },
        data: { status: 'SUSPENDED' },
      }),
    );
    const suspended = await post(booking.id, { rating: 5 });

    expect(unknown.status).toBe(403);
    expect(suspended.status).toBe(403);
    expect(code(unknown.json)).toBe('FORBIDDEN');
    expect(code(suspended.json)).toBe('FORBIDDEN');
  });

  it.each([
    ['a rating out of range', { rating: 6 }, 'INVALID_RATING'],
    ['a fractional rating', { rating: 4.5 }, 'INVALID_RATING'],
    ['a rating sent as a string', { rating: '5' }, 'BAD_REQUEST'],
    ['no rating at all', { body: 'just words' }, 'BAD_REQUEST'],
    ['a body that is not a string', { rating: 5, body: 42 }, 'BAD_REQUEST'],
    ['a body over the limit', { rating: 5, body: 'x'.repeat(2001) }, 'BAD_REQUEST'],
  ])('400 for %s', async (_label, body, expected) => {
    const booking = await seedBooking();

    const { status, json } = await post(booking.id, body);

    expect(status).toBe(400);
    expect(code(json)).toBe(expected);
    expect(await db.review.count({ where: { venueId } })).toBe(0);
  });

  it('400 for a body that is not JSON', async () => {
    const booking = await seedBooking();

    const { status } = await post(booking.id, null, { raw: 'rating=5' });

    expect(status).toBe(400);
  });
});
