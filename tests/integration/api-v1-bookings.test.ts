import { NextRequest } from 'next/server';

import { clearNoShowBlock } from '@/app-layer/usecases/booking-rules';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { POST as checkoutRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/checkout/route';
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import { GET as availabilityRoute } from '@/app/api/v1/venues/[id]/availability/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The booking write path, against a real database.
 *
 * The parts that cannot be unit tested are the ones that matter here: the
 * EXCLUDE constraint arbitrating a genuine race, RLS scoping the reads, and a
 * real bearer token surviving `getToken` + `checkSession`.
 */
describe('POST /api/v1/t/:slug/bookings', () => {
  const db = prismaTestClient();

  let tenant: SeededTenant;
  let owner: TestIdentity;
  let player: TestIdentity;
  /**
   * Another player at the same club: the "somebody else" whose booking is not
   * the caller's. This used to be the owner — but a club account does not play
   * (#263), and the booking route now refuses it.
   */
  let rival: TestIdentity;
  let venueId: string;
  let resourceId: string;

  // 2036-07-16 is a Wednesday. Sofia is UTC+3 in July: 09:00 local = 06:00Z.
  const NINE_AM = '2036-07-16T06:00:00Z';
  const TEN_AM = '2036-07-16T07:00:00Z';

  beforeEach(async () => {
    tenant = await seedTenant({});

    const seeded = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `book-club-${Date.now()}`,
          name: 'Book Club',
          description: 'Courts',
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          phone: '+359000',
          lat: 42.6977123,
          lng: 23.3219456,
          timezone: 'Europe/Sofia',
        },
      });

      const resource = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
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
          tenantId: tenant.tenantId,
          resourceId: resource.id,
          dayOfWeek: 3,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T17:00:00Z'),
        },
      });

      return { venue, resource };
    });

    venueId = seeded.venue.id;
    resourceId = seeded.resource.id;

    const memberships = [
      { tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'OWNER' },
    ];
    owner = await signInAs(db, { userId: tenant.userId, memberships });

    const playerId = await seedPlayer(db, tenant.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });

    const rivalId = await seedPlayer(db, tenant.tenantId, 'rival');
    rival = await signInAs(db, {
      userId: rivalId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });
  });

  const create = async (
    who: TestIdentity,
    body: Record<string, unknown>,
    idempotencyKey = `key-${Math.random()}`,
  ) => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${who.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );
    return { res, body: (await res.json()) as never };
  };

  type Created = { data: { id: string; totalCents: number; status: string } };
  type ApiError = { error: { code: string; message: string } };

  it('creates a booking and prices it SERVER-SIDE', async () => {
    const { res, body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: TEN_AM,
    });

    expect(res.status).toBe(201);
    expect((body as Created).data.totalCents).toBe(2400);
  });

  it('CONFIRMS at once, with no hold — the pilot pays at the club (#354)', async () => {
    const { res, body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

    expect(res.status).toBe(201);
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('CONFIRMED');
    expect(data.expiresAt).toBeNull();
    // The venue's default cutoff is 24 h: the player may cancel until then.
    expect(data.cancellableUntil).toBe('2036-07-15T06:00:00Z');

    const row = await asAppSuperuser(db, (tx) =>
      tx.booking.findUniqueOrThrow({ where: { id: data.id as string } }),
    );
    expect(row).toMatchObject({ status: 'CONFIRMED', expiresAt: null });
  });

  it('refuses a slot that has already started', async () => {
    // Instant confirmation would otherwise make yesterday's court a COMPLETED
    // booking — the proof of visit a review needs.
    const { res, body } = await create(player, {
      resourceId,
      startTs: '2026-07-15T06:00:00Z',
      endTs: '2026-07-15T07:00:00Z',
    });

    expect(res.status).toBe(400);
    expect((body as ApiError).error.code).toBe('SLOT_NOT_BOOKABLE');
  });

  it.each([
    ['notes longer than 500 characters', { notes: 'x'.repeat(501) }, 'notes'],
    ['notes that are not text', { notes: 42 }, 'notes'],
    ['a startTs that is not RFC 3339', { startTs: 'next wednesday' }, 'startTs'],
    ['no resourceId', { resourceId: undefined }, 'resourceId'],
  ])('400s on %s, naming the field', async (_label, override, field) => {
    const { res, body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: TEN_AM,
      ...override,
    });

    expect(res.status).toBe(400);
    const error = (body as { error: { code: string; details: { field: string } } }).error;
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.details.field).toBe(field);
  });

  it('keeps notes up to the cap', async () => {
    const { res } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: TEN_AM,
      notes: 'ring the bell '.repeat(40).slice(0, 500),
    });
    expect(res.status).toBe(201);
  });

  it('IGNORES a price supplied by the client', async () => {
    // The whole reason the route quotes rather than forwards. A client that
    // sends its own total must not be able to buy a €24 court for a cent —
    // and nothing downstream would object, because 1 is a perfectly valid
    // amount, it is just not the club's price.
    const { res, body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: TEN_AM,
      totalCents: 1,
      priceCents: 1,
    });

    expect(res.status).toBe(201);
    expect((body as Created).data.totalCents).toBe(2400);
  });

  it('charges per unit for a multi-hour booking', async () => {
    const { body } = await create(player, {
      resourceId,
      startTs: NINE_AM,
      endTs: '2036-07-16T09:00:00Z', // three hours
    });

    expect((body as Created).data.totalCents).toBe(7200);
  });

  it('quotes the same price the availability endpoint advertised', async () => {
    // Cross-endpoint consistency, end to end. If these drift the app shows one
    // number and charges another, and nothing fails.
    const availRes = await availabilityRoute(
      new NextRequest(`http://t/api/v1/venues/${venueId}/availability?date=2036-07-16`),
      { params: Promise.resolve({ id: venueId }) },
    );
    const avail = (await availRes.json()) as {
      data: {
        resources: Array<{ slots: Array<{ startTs: string; endTs: string; priceCents: number }> }>;
      };
    };

    const slot = avail.data.resources[0]!.slots[0]!;

    const { body } = await create(player, {
      resourceId,
      startTs: slot.startTs,
      endTs: slot.endTs,
    });

    expect((body as Created).data.totalCents).toBe(slot.priceCents);
  });

  it('returns the SAME booking for a repeated idempotency key', async () => {
    // The player taps once, the network stalls, the app retries. A second
    // booking here is a second charge.
    const key = `same-key-${Date.now()}`;

    const first = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, key);
    const second = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, key);

    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(200); // replay, not a new creation
    expect((second.body as Created).data.id).toBe((first.body as Created).data.id);
  });

  it('requires an Idempotency-Key rather than inventing one', async () => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${player.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ resourceId, startTs: NINE_AM, endTs: TEN_AM }),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );

    expect(res.status).toBe(400);
  });

  it('409s when the slot was taken, via the EXCLUDE constraint', async () => {
    await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

    const { res, body } = await create(rival, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

    expect(res.status).toBe(409);
    expect((body as ApiError).error.code).toBe('SLOT_TAKEN');
  });

  it('a burst of simultaneous attempts yields exactly one booking', async () => {
    // What this DOES prove: eight overlapping requests produce one 201 and
    // seven 409s, and the 23P01 from the exclusion constraint is mapped all
    // the way out to SLOT_TAKEN rather than escaping as a 500.
    //
    // What it does NOT prove, checked rather than assumed: it still passes
    // when `createBooking` is given the check-then-insert anti-pattern its own
    // doc comment warns against. These requests do not interleave finely
    // enough between the read and the insert to expose it, so a test claiming
    // otherwise would be decoration.
    //
    // The guarantee actually lives in two places, both already covered:
    // `booking-exclusion.test.ts` asserts booking_no_overlap exists in the
    // live schema, and `migration-safety` fails any migration that drops it.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, `burst-${i}`),
      ),
    );

    const created = attempts.filter((a) => a.res.status === 201);
    const conflicted = attempts.filter((a) => a.res.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);
  });

  it.each([
    ['before opening', '2036-07-16T05:00:00Z', '2036-07-16T06:00:00Z'],
    ['past closing', '2036-07-16T13:00:00Z', '2036-07-16T15:00:00Z'],
    ['not a whole unit', NINE_AM, '2036-07-16T06:30:00Z'],
  ])('rejects a booking %s', async (_label, startTs, endTs) => {
    const { res, body } = await create(player, { resourceId, startTs, endTs });

    expect(res.status).toBe(400);
    expect((body as ApiError).error.code).toBe('SLOT_NOT_BOOKABLE');
  });

  it('401s without a token', async () => {
    const res = await createRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'x' },
        body: JSON.stringify({ resourceId, startTs: NINE_AM, endTs: TEN_AM }),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );

    expect(res.status).toBe(401);
  });

  describe('listing and cancelling', () => {
    const list = async (who: TestIdentity) => {
      const res = await listRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
          headers: { authorization: `Bearer ${who.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug }) },
      );
      return (await res.json()) as { data: { items: Array<{ id: string }> } };
    };

    const cancel = async (who: TestIdentity, bookingId: string) => {
      const res = await cancelRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${bookingId}/cancel`, {
          method: 'POST',
          headers: { authorization: `Bearer ${who.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug, id: bookingId }) },
      );
      return { res, body: (await res.json()) as never };
    };

    it('lists only the caller’s own bookings', async () => {
      const mine = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const theirs = await create(rival, {
        resourceId,
        startTs: '2036-07-16T08:00:00Z',
        endTs: '2036-07-16T09:00:00Z',
      });

      const playerList = await list(player);
      const ids = playerList.data.items.map((b) => b.id);

      expect(ids).toContain((mine.body as Created).data.id);
      expect(ids).not.toContain((theirs.body as Created).data.id);
    });

    it('cancels own booking and quotes the refund', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const id = (body as Created).data.id;

      const { res, body: cancelled } = await cancel(player, id);

      expect(res.status).toBe(200);
      expect(
        (cancelled as { data: { bookingId: string; refundPercent: number } }).data.bookingId,
      ).toBe(id);
    });

    it('404s — not 403 — when cancelling somebody else’s booking', async () => {
      // A PLAYER holds bookings.cancel, so the middleware lets them through.
      // Ownership is a row-level question and only this route can answer it.
      // 403 would confirm the booking exists, which enumerates the club's
      // reservations one id at a time.
      const { body } = await create(rival, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const someoneElses = (body as Created).data.id;

      const { res } = await cancel(player, someoneElses);

      expect(res.status).toBe(404);
    });

    it('409s on a second cancellation instead of writing a second receipt', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const id = (body as Created).data.id;

      await cancel(player, id);
      const { res } = await cancel(player, id);

      expect(res.status).toBe(409);
    });

    it('frees the slot once cancelled', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      await cancel(player, (body as Created).data.id);

      const again = await create(rival, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

      expect(again.res.status).toBe(201);
    });
  });

  /**
   * ═══ A SIGNED-IN PLAYER MAY BOOK AT ANY ACTIVE CLUB ═══
   *
   * Owner's decision. Until this, the only writer of TenantMembership was
   * `acceptInvite` — so booking required the club to have invited you by email,
   * while `/venues` listed every club publicly. The API refused what the
   * catalogue advertised.
   *
   * These run against a real database because the thing being asserted is a
   * ROW: that the membership exists afterwards, with the right role and status,
   * and that it is NOT created on paths that must not create it.
   */
  describe('joining by booking', () => {
    /** A real user with a session and no membership anywhere. */
    const strangerWithNoMembership = async (): Promise<TestIdentity> => {
      const userId = await asAppSuperuser(db, async (tx) => {
        const u = await tx.user.create({
          data: {
            email: `stranger-${Math.random().toString(36).slice(2, 10)}@playerz.test`,
            name: 'Stranger',
            passwordHash: null,
          },
          select: { id: true },
        });
        return u.id;
      });
      // memberships: [] — exactly what a first-time OAuth user's token carries.
      return signInAs(db, { userId, memberships: [] });
    };

    const membershipOf = (userId: string) =>
      asAppSuperuser(db, (tx) =>
        tx.tenantMembership.findUnique({
          where: { userId_tenantId: { userId, tenantId: tenant.tenantId } },
          select: { role: true, status: true, acceptedAt: true },
        }),
      );

    it('lets a stranger book, and makes them an ACTIVE PLAYER', async () => {
      const stranger = await strangerWithNoMembership();
      expect(await membershipOf(stranger.userId)).toBeNull();

      const { res } = await create(stranger, {
        resourceId,
        startTs: NINE_AM,
        endTs: TEN_AM,
      });

      expect(res.status).toBe(201);
      expect(await membershipOf(stranger.userId)).toMatchObject({
        role: 'PLAYER',
        status: 'ACTIVE',
      });
    });

    it('marks the membership accepted, not invited', async () => {
      // A null acceptedAt would make this look like an invitation nobody
      // answered, and the club's members list would show a pending row for
      // somebody who has already paid for a court.
      const stranger = await strangerWithNoMembership();
      await create(stranger, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

      const m = await membershipOf(stranger.userId);
      expect(m?.acceptedAt).toBeInstanceOf(Date);
    });

    it('refuses the club’s own OWNER — a club account books with a player account (#263)', async () => {
      // This used to book, and pinned only that the owner was not demoted by
      // it. One account is one kind now: booking is playing, and an owner who
      // plays does so with their player account. Refused at their OWN club
      // too, where they would not even have had to join — and left untouched.
      const { res, body } = await create(owner, {
        resourceId,
        startTs: '2036-07-16T08:00:00Z',
        endTs: '2036-07-16T09:00:00Z',
      });

      expect(res.status).toBe(403);
      expect((body as ApiError).error.code).toBe('PLAYER_ACCOUNT_REQUIRED');
      expect(await membershipOf(owner.userId)).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    });

    it('refuses a SUSPENDED member, and does not reactivate them', async () => {
      // SUSPENDED is the club's deliberate act. Booking a court must not undo a
      // moderation decision.
      const suspended = await strangerWithNoMembership();
      await asAppSuperuser(db, (tx) =>
        tx.tenantMembership.create({
          data: {
            userId: suspended.userId,
            tenantId: tenant.tenantId,
            role: 'PLAYER',
            status: 'SUSPENDED',
          },
        }),
      );

      const { res } = await create(suspended, {
        resourceId,
        startTs: NINE_AM,
        endTs: TEN_AM,
      });

      expect(res.status).toBe(404);
      expect(await membershipOf(suspended.userId)).toMatchObject({ status: 'SUSPENDED' });
    });

    it('refuses a club that is not ACTIVE, and does not enrol anyone in it', async () => {
      // A membership created at a suspended club would outlive the suspension,
      // so the club must be unjoinable and not merely unbookable.
      const stranger = await strangerWithNoMembership();
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.update({
          where: { id: tenant.tenantId },
          data: { status: 'SUSPENDED' },
        }),
      );

      const { res } = await create(stranger, {
        resourceId,
        startTs: NINE_AM,
        endTs: TEN_AM,
      });

      expect(res.status).toBe(404);
      expect(await membershipOf(stranger.userId)).toBeNull();
    });

    it('LISTING does not join a club', async () => {
      // Reading must never have that side effect. Otherwise opening a club's
      // page would enrol you in it.
      const stranger = await strangerWithNoMembership();

      const res = await listRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
          headers: { authorization: `Bearer ${stranger.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug }) },
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);
      expect(await membershipOf(stranger.userId)).toBeNull();
    });

    it('resolves a membership the TOKEN does not carry', async () => {
      // contextFromRequest says absence from a truncated membership list proves
      // nothing and that "the route resolves membership authoritatively against
      // the database". No route did — `ctx.tenantId!` was a non-null assertion
      // on a genuine null, so a player with more clubs than fit in their token
      // could not book at the 51st.
      //
      // Same database state as a real member; token deliberately empty.
      const playerId = await seedPlayer(db, tenant.tenantId);
      const tokenSaysNothing = await signInAs(db, { userId: playerId, memberships: [] });

      const { res } = await create(tokenSaysNothing, {
        resourceId,
        startTs: NINE_AM,
        endTs: TEN_AM,
      });

      expect(res.status).toBe(201);
      // Still PLAYER, and still the row seedPlayer made — not a second one.
      expect(await membershipOf(playerId)).toMatchObject({ role: 'PLAYER', status: 'ACTIVE' });
    });
  });

  /**
   * ═══ THE PILOT'S RULES (#354) ═══
   *
   * A player cancels until the venue's cutoff and never after the start; the
   * desk may always cancel. Three no-shows in 90 days block online booking at
   * the club until staff lift it. Checkout is off.
   */
  describe('the pilot booking model', () => {
    const HOUR = 3_600_000;

    const cancel = async (who: TestIdentity, bookingId: string) => {
      const res = await cancelRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${bookingId}/cancel`, {
          method: 'POST',
          headers: { authorization: `Bearer ${who.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug, id: bookingId }) },
      );
      return { res, body: (await res.json()) as never };
    };

    /** Book through the route, then move the booking to `hoursFromNow`. */
    const bookStartingIn = async (hoursFromNow: number) => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const id = (body as Created).data.id;
      const startTs = new Date(Date.now() + hoursFromNow * HOUR);
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({
          where: { id },
          data: { startTs, endTs: new Date(startTs.getTime() + HOUR) },
        }),
      );
      return id;
    };

    const setCutoff = (hours: number) =>
      asAppSuperuser(db, (tx) =>
        tx.venue.update({ where: { id: venueId }, data: { cancellationCutoffHours: hours } }),
      );

    const statusOf = async (id: string) =>
      (await asAppSuperuser(db, (tx) => tx.booking.findUniqueOrThrow({ where: { id } }))).status;

    it('a player cancels BEFORE the cutoff, and is quoted nothing — nothing was paid', async () => {
      const id = await bookStartingIn(30);

      const { res, body } = await cancel(player, id);

      expect(res.status).toBe(200);
      expect((body as { data: Record<string, unknown> }).data).toMatchObject({
        refundPercent: 0,
        refundAmountCents: 0,
      });
      expect(await statusOf(id)).toBe('CANCELLED');
    });

    it('a player is REFUSED after the cutoff, in their own language; the desk is not', async () => {
      const id = await bookStartingIn(2);

      const refused = await cancel(player, id);
      expect(refused.res.status).toBe(403);
      const error = (refused.body as ApiError).error;
      expect(error.code).toBe('CANCELLATION_CUTOFF_PASSED');
      // `User.locale` defaults to bg: the sentence the player reads is Bulgarian.
      expect(error.message).toContain('24 часа');
      expect(await statusOf(id)).toBe('CONFIRMED');

      // The OWNER holds bookings.view_all: the club may always cancel.
      const byClub = await cancel(owner, id);
      expect(byClub.res.status).toBe(200);
      expect(await statusOf(id)).toBe('CANCELLED');

      const audit = await asAppSuperuser(db, (tx) =>
        tx.auditEntry.findFirstOrThrow({
          where: { entityId: id, action: 'BOOKING_CANCELLED' },
        }),
      );
      expect(audit.actorUserId).toBe(owner.userId);
      expect(audit.detailsJson).toMatchObject({ actor: 'STAFF', cutoffHours: 24 });
    });

    it('the cutoff is the VENUE’s setting', async () => {
      await setCutoff(1);
      const id = await bookStartingIn(2);

      expect((await cancel(player, id)).res.status).toBe(200);
    });

    it('a player can never cancel once it has started, even with a cutoff of 0', async () => {
      await setCutoff(0);
      const id = await bookStartingIn(-0.5);

      const refused = await cancel(player, id);
      expect(refused.res.status).toBe(403);
      expect((refused.body as ApiError).error.code).toBe('CANCELLATION_CUTOFF_PASSED');

      expect((await cancel(owner, id)).res.status).toBe(200);
    });

    it('checkout is off: 409 ONLINE_PAYMENT_DISABLED, and nothing is charged', async () => {
      const { body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });
      const id = (body as Created).data.id;

      const res = await checkoutRoute(
        new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${id}/checkout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${player.bearer}` },
        }),
        { params: Promise.resolve({ slug: tenant.tenantSlug, id }) },
      );

      expect(res.status).toBe(409);
      expect(((await res.json()) as ApiError).error.code).toBe('ONLINE_PAYMENT_DISABLED');
      const payments = await asAppSuperuser(db, (tx) =>
        tx.payment.count({ where: { bookingId: id } }),
      );
      expect(payments).toBe(0);
    });

    it('a RETRY that lands after the slot started still returns the booking it made', async () => {
      // The start check runs after the idempotent replay: a player whose
      // request stalled must not be told "cannot be booked" about a booking
      // that exists.
      const key = 'stalled-retry';
      const first = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, key);
      const id = (first.body as Created).data.id;
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({
          where: { id },
          data: { startTs: new Date(Date.now() - HOUR), endTs: new Date(Date.now()) },
        }),
      );

      const retry = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM }, key);
      expect(retry.res.status).toBe(200);
      expect((retry.body as Created).data.id).toBe(id);
    });

    it('a club that DOES take payment online still gets the PENDING hold checkout expects', async () => {
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.update({
          where: { id: tenant.tenantId },
          data: { onlinePaymentEnabled: true },
        }),
      );

      const { res, body } = await create(player, { resourceId, startTs: NINE_AM, endTs: TEN_AM });

      expect(res.status).toBe(201);
      const data = (body as { data: { status: string; expiresAt: string | null } }).data;
      expect(data.status).toBe('PENDING');
      expect(data.expiresAt).not.toBeNull();
    });

    describe('the no-show block', () => {
      let noShowHour = 0;

      /** A NO_SHOW booking for `userId`, `daysAgo` days back, each on its own hour. */
      const noShow = (userId: string, daysAgo: number) =>
        asAppSuperuser(db, (tx) => {
          const startTs = new Date(Date.now() - daysAgo * 86_400_000 - noShowHour++ * HOUR);
          return tx.booking.create({
            data: {
              tenantId: tenant.tenantId,
              resourceId,
              startTs,
              endTs: new Date(startTs.getTime() + HOUR),
              status: 'NO_SHOW',
              totalCents: 2400,
              idempotencyKey: `no-show-${Math.random()}`,
              bookedByUserId: userId,
            },
          });
        });

      const bookAt = (hourUtc: number, key?: string) =>
        create(
          player,
          {
            resourceId,
            startTs: `2036-07-16T${String(hourUtc).padStart(2, '0')}:00:00Z`,
            endTs: `2036-07-16T${String(hourUtc + 1).padStart(2, '0')}:00:00Z`,
          },
          key,
        );

      it('two no-shows do not block', async () => {
        await noShow(player.userId, 3);
        await noShow(player.userId, 10);

        expect((await bookAt(6)).res.status).toBe(201);
      });

      it('THREE in 90 days block online booking, in the player’s language', async () => {
        await noShow(player.userId, 3);
        await noShow(player.userId, 10);
        await noShow(player.userId, 80);

        const { res, body } = await bookAt(6);

        expect(res.status).toBe(403);
        const error = (body as ApiError).error;
        expect(error.code).toBe('NO_SHOW_BLOCKED');
        expect(error.message).toContain('неявявания');
        expect(error.message).toContain('90');

        const made = await asAppSuperuser(db, (tx) =>
          tx.booking.count({ where: { bookedByUserId: player.userId, status: 'CONFIRMED' } }),
        );
        expect(made).toBe(0);
      });

      it('a no-show older than 90 days no longer counts', async () => {
        await noShow(player.userId, 3);
        await noShow(player.userId, 10);
        await noShow(player.userId, 91);

        expect((await bookAt(6)).res.status).toBe(201);
      });

      it('is per player: another player’s no-shows do not block this one', async () => {
        await noShow(rival.userId, 1);
        await noShow(rival.userId, 2);
        await noShow(rival.userId, 3);

        expect((await bookAt(6)).res.status).toBe(201);
      });

      it('an idempotent REPLAY of a booking made before the block still returns it', async () => {
        const first = await bookAt(6, 'before-the-block');
        expect(first.res.status).toBe(201);

        await noShow(player.userId, 1);
        await noShow(player.userId, 2);
        await noShow(player.userId, 3);

        const replay = await bookAt(6, 'before-the-block');
        expect(replay.res.status).toBe(200);
        expect((replay.body as Created).data.id).toBe((first.body as Created).data.id);

        // …while a NEW booking is refused.
        expect((await bookAt(8)).res.status).toBe(403);
      });

      it('staff lift it — recorded with who and when — and the player books again', async () => {
        await noShow(player.userId, 3);
        await noShow(player.userId, 10);
        await noShow(player.userId, 80);
        expect((await bookAt(6)).res.status).toBe(403);

        const lifted = await asAppSuperuser(db, (tx) =>
          clearNoShowBlock(tx, tenant.tenantId, {
            playerUserId: player.userId,
            actorUserId: owner.userId,
          }),
        );
        expect(lifted.recentNoShows).toBe(3);

        expect((await bookAt(6)).res.status).toBe(201);

        const rel = await asAppSuperuser(db, (tx) =>
          tx.playerVenueRelationship.findUniqueOrThrow({
            where: {
              tenantId_playerUserId: { tenantId: tenant.tenantId, playerUserId: player.userId },
            },
          }),
        );
        expect(rel.noShowBlockClearedByUserId).toBe(owner.userId);
        expect(rel.noShowBlockClearedAt).toEqual(lifted.clearedAt);

        const audit = await asAppSuperuser(db, (tx) =>
          tx.auditEntry.findFirstOrThrow({
            where: { entityId: player.userId, action: 'PLAYER_NO_SHOW_BLOCK_CLEARED' },
          }),
        );
        expect(audit).toMatchObject({ actorUserId: owner.userId, tenantId: tenant.tenantId });

        // Three NEW no-shows after a lift block again. (The lift is moved back
        // ten days so the new ones can sit after it and still be in the past.)
        await asAppSuperuser(db, (tx) =>
          tx.playerVenueRelationship.update({
            where: { id: rel.id },
            data: { noShowBlockClearedAt: new Date(Date.now() - 10 * 86_400_000) },
          }),
        );
        await noShow(player.userId, 1);
        await noShow(player.userId, 2);
        await noShow(player.userId, 4);
        expect((await bookAt(9)).res.status).toBe(403);
      });

      it('lifting refuses when there is no block — no pre-forgiving', async () => {
        await noShow(player.userId, 3);

        await expect(
          asAppSuperuser(db, (tx) =>
            clearNoShowBlock(tx, tenant.tenantId, {
              playerUserId: player.userId,
              actorUserId: owner.userId,
            }),
          ),
        ).rejects.toMatchObject({ name: 'NoShowBlockNotSetError' });
      });
    });
  });
});
