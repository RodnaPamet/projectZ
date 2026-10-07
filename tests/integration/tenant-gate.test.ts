import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';

import { POST as adminVenues } from '@/app/api/t/[slug]/admin/venues/route';
import { POST as signInNative } from '@/app/api/v1/auth/token/route';
import { POST as cancel } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { POST as checkout } from '@/app/api/v1/t/[slug]/bookings/[id]/checkout/route';
import { GET as listBookings, POST as createBooking } from '@/app/api/v1/t/[slug]/bookings/route';
import { POST as connectOnboarding } from '@/app/api/v1/t/[slug]/connect/onboarding/route';
import { GET as me } from '@/app/api/v1/t/[slug]/me/route';
import { hashPassword } from '@/lib/auth/passwords';
import { config as middlewareConfig, middleware } from '@/middleware';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE TENANT GATE, THROUGH THE MIDDLEWARE (#250).
 *
 * ═══ WHY NOTHING CAUGHT #250 ═══
 *
 * Every other integration test calls a route handler directly —
 * `POST(new NextRequest(...))` — which skips `src/middleware.ts` entirely. The
 * handlers were right; the edge in front of them refused every
 * `/api/v1/t/{slug}/**` call from a native token, and every call at a club
 * joined after sign-in, and no test ever sent a request through it.
 *
 * So every request here goes the way Next serves it: the real middleware
 * first, with its real `getToken`, and the route handler only if the
 * middleware let the request on (`x-middleware-next: 1`). The native token
 * comes from the real `/auth/token` route; the web session is a real encrypted
 * cookie over a real `user_session` row.
 *
 * `unstable_doesMiddlewareMatch` proves the middleware's own matcher selects
 * these paths — otherwise "through the middleware" would be a claim about a
 * function call, not about what Next does.
 */

const db = prismaTestClient();
const PASSWORD = 'correct horse battery staple';

// 2036-07-16 is a Wednesday; Sofia is UTC+3 in July, so 09:00 local is 06:00Z.
const slot = (hourUtc: number) => ({
  startTs: `2036-07-16T${String(hourUtc).padStart(2, '0')}:00:00Z`,
  endTs: `2036-07-16T${String(hourUtc + 1).padStart(2, '0')}:00:00Z`,
});

type Params = Record<string, string>;
type Handler = (req: NextRequest, ctx: { params: Promise<Params> }) => Promise<Response>;

interface Answer {
  status: number;
  /** Who answered: the edge, or the route behind it. */
  by: 'edge' | 'route';
  body: unknown;
}

interface Caller {
  /** `Authorization: Bearer …` for a native token, `Cookie: …` for a web session. */
  headers: Record<string, string>;
}

const ANONYMOUS: Caller = { headers: {} };

let ipCounter = 0;

/**
 * One request, the way Next serves it: the middleware, then — only if it let
 * the request on — the route. Two NextRequest objects from one description,
 * because a body can be read once and the middleware must not be the reader.
 */
async function send(
  handler: Handler,
  params: Params,
  method: string,
  path: string,
  who: Caller,
  body?: unknown,
): Promise<Answer> {
  const url = `http://localhost:3000${path}`;
  const init = () => ({
    method,
    headers: {
      ...who.headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' && path.endsWith('/bookings')
        ? { 'idempotency-key': `key-${Math.random()}` }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url: path })).toBe(true);

  const edge = await middleware(new NextRequest(url, init()));
  if (edge.headers.get('x-middleware-next') !== '1') {
    return { status: edge.status, by: 'edge', body: await edge.json().catch(() => null) };
  }

  const res = await handler(new NextRequest(url, init()), { params: Promise.resolve(params) });
  return { status: res.status, by: 'route', body: await res.json().catch(() => null) };
}

/** The error body without its per-request id, so two refusals can be compared whole. */
const withoutRequestId = (body: unknown) => {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return body;
  const { requestId: _dropped, ...rest } = error;
  return { error: rest };
};

async function newUser(
  label: string,
  password?: string,
  accountKind: 'PLAYER' | 'CLUB' = 'PLAYER',
): Promise<{ id: string; email: string }> {
  const email = `${label}-${Math.random().toString(36).slice(2, 10)}@playerz.test`;
  const passwordHash = password ? await hashPassword(password) : null;
  const user = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: { email, name: label, passwordHash, accountKind },
      select: { id: true },
    }),
  );
  return { id: user.id, email };
}

async function join(userId: string, tenantId: string, role: 'PLAYER' | 'STAFF' | 'OWNER') {
  await asAppSuperuser(db, (tx) =>
    tx.tenantMembership.create({ data: { userId, tenantId, role, status: 'ACTIVE' } }),
  );
}

const membership = (userId: string, tenantId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { role: true, status: true },
    }),
  );

/** A court at the club, open 09:00–17:00 Sofia time on Wednesdays. */
async function bookable(t: SeededTenant): Promise<string> {
  return asAppSuperuser(db, async (tx) => {
    const venue = await tx.venue.create({
      data: {
        tenantId: t.tenantId,
        slug: `gate-${Math.random().toString(36).slice(2, 10)}`,
        name: 'Gate Club',
        description: 'Courts',
        addressLine: '1 Court St',
        city: 'Sofia',
        email: 'internal@club.test',
        phone: '+359000',
        lat: 42.69,
        lng: 23.32,
        timezone: 'Europe/Sofia',
      },
    });
    const resource = await tx.resource.create({
      data: {
        tenantId: t.tenantId,
        venueId: venue.id,
        name: 'Court 1',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
        minBookingMinutes: 60,
        maxBookingMinutes: 180,
        slotStepMinutes: 60,
      },
    });
    await tx.resourceAvailability.create({
      data: {
        tenantId: t.tenantId,
        resourceId: resource.id,
        dayOfWeek: 3,
        openTime: new Date('1970-01-01T09:00:00Z'),
        closeTime: new Date('1970-01-01T17:00:00Z'),
      },
    });
    return resource.id;
  });
}

/** A NATIVE sign-in, through the real `/auth/token` route — and through the middleware. */
async function nativeSignIn(email: string): Promise<Caller> {
  const res = await send(
    signInNative as Handler,
    {},
    'POST',
    '/api/v1/auth/token',
    {
      headers: {
        'x-forwarded-for': `10.250.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
      },
    },
    { email, password: PASSWORD },
  );

  expect(res).toMatchObject({ status: 200, by: 'route' });
  const { accessToken } = (res.body as { data: { accessToken: string } }).data;
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

/** A WEB session: the encrypted cookie next-auth sets, listing the clubs it was signed in with. */
async function webSignIn(
  userId: string,
  memberships: Array<{ tenantId: string; tenantSlug: string; role: string }>,
  claims: Record<string, unknown> = {},
): Promise<Caller> {
  const { bearer } = await signInAs(db, { userId, memberships, claims });
  // Both names: which one `getToken` reads depends on whether NEXTAUTH_URL is https.
  return {
    headers: {
      cookie: `next-auth.session-token=${bearer}; __Secure-next-auth.session-token=${bearer}`,
    },
  };
}

let clubA: SeededTenant;
let clubB: SeededTenant;
let courtA: string;
let courtB: string;
let player: { id: string; email: string };

beforeEach(async () => {
  clubA = await seedTenant({ name: 'Club A' });
  clubB = await seedTenant({ name: 'Club B' });
  courtA = await bookable(clubA);
  courtB = await bookable(clubB);

  // A player at A, and a stranger to B.
  player = await newUser('player', PASSWORD);
  await join(player.id, clubA.tenantId, 'PLAYER');
});

const bookingsPath = (t: SeededTenant) => `/api/v1/t/${t.tenantSlug}/bookings`;

async function book(who: Caller, t: SeededTenant, court: string, hourUtc: number) {
  return send(createBooking as Handler, { slug: t.tenantSlug }, 'POST', bookingsPath(t), who, {
    resourceId: court,
    ...slot(hourUtc),
  });
}

const idOf = (a: Answer) => (a.body as { data: { id: string } }).data.id;

describe('a NATIVE token at its own club', () => {
  it('THE POINT: reads, books and cancels — every one of these was a 403 at the edge', async () => {
    const native = await nativeSignIn(player.email);

    const who = await send(
      me as Handler,
      { slug: clubA.tenantSlug },
      'GET',
      `/api/v1/t/${clubA.tenantSlug}/me`,
      native,
    );
    expect(who).toMatchObject({ status: 200, by: 'route' });
    expect((who.body as { data: { membership: { role: string } } }).data.membership.role).toBe(
      'PLAYER',
    );

    const booked = await book(native, clubA, courtA, 6);
    expect(booked).toMatchObject({ status: 201, by: 'route' });

    const listed = await send(
      listBookings as Handler,
      { slug: clubA.tenantSlug },
      'GET',
      bookingsPath(clubA),
      native,
    );
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { data: { items: Array<{ id: string }> } }).data.items.map((b) => b.id),
    ).toEqual([idOf(booked)]);

    const cancelled = await send(
      cancel as Handler,
      { slug: clubA.tenantSlug, id: idOf(booked) },
      'POST',
      `/api/v1/t/${clubA.tenantSlug}/bookings/${idOf(booked)}/cancel`,
      native,
    );
    expect(cancelled).toMatchObject({ status: 200, by: 'route' });
  });

  it('reaches checkout, where the club — not the gate — says no', async () => {
    // Club A takes payment at the club (#354), so checkout refuses with 409.
    // That answer can only come from inside the handler, past every
    // authorisation step.
    const native = await nativeSignIn(player.email);
    const booked = await book(native, clubA, courtA, 7);

    const paid = await send(
      checkout as Handler,
      { slug: clubA.tenantSlug, id: idOf(booked) },
      'POST',
      `/api/v1/t/${clubA.tenantSlug}/bookings/${idOf(booked)}/checkout`,
      native,
    );

    expect(paid).toMatchObject({ status: 409, by: 'route' });
    expect((paid.body as { error: { code: string } }).error.code).toBe('ONLINE_PAYMENT_DISABLED');
  });

  it('is never told its token is stale — it carries no claims to go stale', async () => {
    // `tokenStale` used to be true on every native call: no claim for the slug
    // compared unequal to the database, and refreshing mints no claims either.
    const native = await nativeSignIn(player.email);

    const who = await send(
      me as Handler,
      { slug: clubA.tenantSlug },
      'GET',
      `/api/v1/t/${clubA.tenantSlug}/me`,
      native,
    );

    expect((who.body as { data: { tokenStale: boolean } }).data.tokenStale).toBe(false);
  });
});

describe('a NATIVE token at a club it does not belong to', () => {
  it('JOINS by booking (#229) — and is a PLAYER there afterwards', async () => {
    const native = await nativeSignIn(player.email);
    expect(await membership(player.id, clubB.tenantId)).toBeNull();

    const booked = await book(native, clubB, courtB, 8);

    expect(booked).toMatchObject({ status: 201, by: 'route' });
    expect(await membership(player.id, clubB.tenantId)).toEqual({
      role: 'PLAYER',
      status: 'ACTIVE',
    });

    const who = await send(
      me as Handler,
      { slug: clubB.tenantSlug },
      'GET',
      `/api/v1/t/${clubB.tenantSlug}/me`,
      native,
    );
    expect(who).toMatchObject({ status: 200, by: 'route' });
  });

  it('is refused everything else there, by the route, and joins nothing', async () => {
    const native = await nativeSignIn(player.email);

    // A booking at B that is not theirs — another player's, who joined by it.
    const other = await newUser('other-player', PASSWORD);
    const theirs = await book(await nativeSignIn(other.email), clubB, courtB, 9);
    expect(theirs.status).toBe(201);

    const cancelled = await send(
      cancel as Handler,
      { slug: clubB.tenantSlug, id: idOf(theirs) },
      'POST',
      `/api/v1/t/${clubB.tenantSlug}/bookings/${idOf(theirs)}/cancel`,
      native,
    );
    // The edge let it on; the route refused it, before looking at the booking.
    expect(cancelled).toMatchObject({ status: 403, by: 'route' });
    expect(withoutRequestId(cancelled.body)).toEqual({
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });

    const who = await send(
      me as Handler,
      { slug: clubB.tenantSlug },
      'GET',
      `/api/v1/t/${clubB.tenantSlug}/me`,
      native,
    );
    expect(who).toMatchObject({ status: 404, by: 'route' });

    const listed = await send(
      listBookings as Handler,
      { slug: clubB.tenantSlug },
      'GET',
      bookingsPath(clubB),
      native,
    );
    expect(listed).toMatchObject({ status: 200, by: 'route' });
    expect((listed.body as { data: { items: unknown[] } }).data.items).toEqual([]);

    const payouts = await send(
      connectOnboarding as Handler,
      { slug: clubB.tenantSlug },
      'POST',
      `/api/v1/t/${clubB.tenantSlug}/connect/onboarding`,
      native,
    );
    expect(payouts).toMatchObject({ status: 403, by: 'route' });

    // Nothing above is a way in.
    expect(await membership(player.id, clubB.tenantId)).toBeNull();
    expect(
      await asAppSuperuser(db, (tx) => tx.booking.findUnique({ where: { id: idOf(theirs) } })),
    ).toMatchObject({
      // Untouched: still the CONFIRMED booking its owner made (#354).
      status: 'CONFIRMED',
    });
  });
});

describe('a WEB session at a club joined after sign-in', () => {
  it('books, lists and cancels at the club its cookie does not list', async () => {
    // Signed in when they belonged to A only; the cookie says so for a week.
    const web = await webSignIn(player.id, [
      { tenantId: clubA.tenantId, tenantSlug: clubA.tenantSlug, role: 'PLAYER' },
    ]);

    // #229's own write — the first thing the edge refused (#250).
    const booked = await book(web, clubB, courtB, 10);
    expect(booked).toMatchObject({ status: 201, by: 'route' });

    const listed = await send(
      listBookings as Handler,
      { slug: clubB.tenantSlug },
      'GET',
      bookingsPath(clubB),
      web,
    );
    expect(
      (listed.body as { data: { items: Array<{ id: string }> } }).data.items.map((b) => b.id),
    ).toEqual([idOf(booked)]);

    const cancelled = await send(
      cancel as Handler,
      { slug: clubB.tenantSlug, id: idOf(booked) },
      'POST',
      `/api/v1/t/${clubB.tenantSlug}/bookings/${idOf(booked)}/cancel`,
      web,
    );
    expect(cancelled).toMatchObject({ status: 200, by: 'route' });
  });

  it('is recognised at a club it joined some other way, too — an invite, say', async () => {
    const web = await webSignIn(player.id, [
      { tenantId: clubA.tenantId, tenantSlug: clubA.tenantSlug, role: 'PLAYER' },
    ]);
    await join(player.id, clubB.tenantId, 'PLAYER'); // after the cookie was minted

    const who = await send(
      me as Handler,
      { slug: clubB.tenantSlug },
      'GET',
      `/api/v1/t/${clubB.tenantSlug}/me`,
      web,
    );

    expect(who).toMatchObject({ status: 200, by: 'route' });
    expect(
      (who.body as { data: { membership: { role: string }; tokenStale: boolean } }).data,
    ).toMatchObject({
      membership: { role: 'PLAYER' },
      // The cookie does not LIST club B, so there is no claim for it to be
      // stale about: the edge deferred B to the database.
      tokenStale: false,
    });
  });
});

describe('an anonymous caller', () => {
  it('is refused at the edge, before any route runs', async () => {
    const read = await send(
      listBookings as Handler,
      { slug: clubA.tenantSlug },
      'GET',
      bookingsPath(clubA),
      ANONYMOUS,
    );
    const write = await book(ANONYMOUS, clubA, courtA, 6);

    for (const answer of [read, write]) {
      expect(answer).toMatchObject({ status: 401, by: 'edge' });
      expect(answer.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }
  });

  it('is sent to sign in from a club page, with the page to come back to', async () => {
    const res = await middleware(
      new NextRequest(`http://localhost:3000/t/${clubA.tenantSlug}/admin/calendar`),
    );

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe(`/t/${clubA.tenantSlug}/admin/calendar`);
  });
});

describe('a club that does not exist looks exactly like one you are not in', () => {
  it('on every route, at both layers', async () => {
    const native = await nativeSignIn(player.email);
    const ghost = 'no-such-club-anywhere';

    const pairs: Array<[Answer, Answer]> = [
      [
        await send(
          me as Handler,
          { slug: clubB.tenantSlug },
          'GET',
          `/api/v1/t/${clubB.tenantSlug}/me`,
          native,
        ),
        await send(me as Handler, { slug: ghost }, 'GET', `/api/v1/t/${ghost}/me`, native),
      ],
      [
        await send(
          listBookings as Handler,
          { slug: clubB.tenantSlug },
          'GET',
          bookingsPath(clubB),
          native,
        ),
        await send(
          listBookings as Handler,
          { slug: ghost },
          'GET',
          `/api/v1/t/${ghost}/bookings`,
          native,
        ),
      ],
      [
        await send(
          cancel as Handler,
          { slug: clubB.tenantSlug, id: 'bk_1' },
          'POST',
          `/api/v1/t/${clubB.tenantSlug}/bookings/bk_1/cancel`,
          native,
        ),
        await send(
          cancel as Handler,
          { slug: ghost, id: 'bk_1' },
          'POST',
          `/api/v1/t/${ghost}/bookings/bk_1/cancel`,
          native,
        ),
      ],
      [
        await send(
          connectOnboarding as Handler,
          { slug: clubB.tenantSlug },
          'POST',
          `/api/v1/t/${clubB.tenantSlug}/connect/onboarding`,
          native,
        ),
        await send(
          connectOnboarding as Handler,
          { slug: ghost },
          'POST',
          `/api/v1/t/${ghost}/connect/onboarding`,
          native,
        ),
      ],
    ];

    for (const [real, invented] of pairs) {
      expect(real.by).toBe(invented.by);
      expect(real.status).toBe(invented.status);
      expect(withoutRequestId(real.body)).toEqual(withoutRequestId(invented.body));
    }
  });

  it('a club that cannot be joined answers a booking exactly like one that does not exist', async () => {
    // An ACTIVE club is joinable by design (#229) and listed publicly anyway.
    // A suspended one must not be told apart from nothing at all.
    const native = await nativeSignIn(player.email);
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: clubB.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    const suspended = await book(native, clubB, courtB, 8);
    const invented = await send(
      createBooking as Handler,
      { slug: 'no-such-club-anywhere' },
      'POST',
      '/api/v1/t/no-such-club-anywhere/bookings',
      native,
      { resourceId: courtB, ...slot(8) },
    );

    expect(suspended).toMatchObject({ status: 404, by: 'route' });
    expect(withoutRequestId(suspended.body)).toEqual(withoutRequestId(invented.body));
    expect(await membership(player.id, clubB.tenantId)).toBeNull();
  });
});

describe('a mutation that needs a permission the caller lacks', () => {
  it('is refused by the ROUTE for a native token, naming the permission', async () => {
    // The edge had no claim to check, so it let the request on. That did not
    // make it allowed: the route checked the table against the database role.
    const native = await nativeSignIn(player.email);

    const payouts = await send(
      connectOnboarding as Handler,
      { slug: clubA.tenantSlug },
      'POST',
      `/api/v1/t/${clubA.tenantSlug}/connect/onboarding`,
      native,
    );
    const venues = await send(
      adminVenues as Handler,
      { slug: clubA.tenantSlug },
      'POST',
      `/api/t/${clubA.tenantSlug}/admin/venues`,
      native,
      {},
    );

    expect(payouts).toMatchObject({ status: 403, by: 'route' });
    expect(withoutRequestId(payouts.body)).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Forbidden',
        details: { requiredPermission: 'admin.billing_manage' },
      },
    });
    // The legacy stub trusted the edge outright. It checks for itself now.
    expect(venues).toMatchObject({ status: 403, by: 'route' });
  });

  it('is still refused at the EDGE when the token lists the club with too small a role', async () => {
    const web = await webSignIn(player.id, [
      { tenantId: clubA.tenantId, tenantSlug: clubA.tenantSlug, role: 'PLAYER' },
    ]);

    const payouts = await send(
      connectOnboarding as Handler,
      { slug: clubA.tenantSlug },
      'POST',
      `/api/v1/t/${clubA.tenantSlug}/connect/onboarding`,
      web,
    );

    expect(payouts).toMatchObject({ status: 403, by: 'edge' });
    expect(payouts.body).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Forbidden',
        details: { requiredPermission: 'admin.billing_manage' },
      },
    });
  });

  it('is refused by the route when the token OVERSTATES the role — a demotion since sign-in', async () => {
    // The claim says OWNER, so the edge's check passes. The database says
    // PLAYER, and the database is what the route asks.
    const web = await webSignIn(player.id, [
      { tenantId: clubA.tenantId, tenantSlug: clubA.tenantSlug, role: 'OWNER' },
    ]);

    const venues = await send(
      adminVenues as Handler,
      { slug: clubA.tenantSlug },
      'POST',
      `/api/t/${clubA.tenantSlug}/admin/venues`,
      web,
      {},
    );

    expect(venues).toMatchObject({ status: 403, by: 'route' });
  });

  it('is let through for a caller whose database role holds it', async () => {
    // The control for the three above: the same stub, an owner, a native token.
    const owner = await newUser('owner', PASSWORD, 'CLUB');
    await join(owner.id, clubB.tenantId, 'OWNER');
    const native = await nativeSignIn(owner.email);

    const venues = await send(
      adminVenues as Handler,
      { slug: clubB.tenantSlug },
      'POST',
      `/api/t/${clubB.tenantSlug}/admin/venues`,
      native,
      {},
    );

    expect(venues).toMatchObject({ status: 501, by: 'route' });
  });
});
