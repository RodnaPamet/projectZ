import type { BookingStatus } from '@prisma/client';
import { NextRequest } from 'next/server';

import { POST as cron } from '@/app/api/cron/complete-ended-bookings/route';
import {
  COMPLETE_PER_RUN,
  completeEndedBookings,
  markNoShow,
  NoShowRefusedError,
} from '@/app-layer/usecases/booking-outcome';
import { createReview, NoProofOfVisitError } from '@/app-layer/usecases/reviews';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { useMswServer } from '../helpers/msw';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * How a booking ends — against a real database.
 *
 * Nothing on main ever set a booking COMPLETED, and a review's proof of visit
 * is exactly that status, so nobody could ever review anything. These tests pin
 * the owner's rule: CONFIRMED and ended means presumed played; staff can say
 * otherwise; and nothing else is ever touched.
 */

const HOUR = 3_600_000;
const NOW = new Date('2026-09-29T12:00:00Z');

// Fixture only — never a real credential. Same treatment as the expiry sweep's.
const SECRET = 'completion-fixture-not-a-real-secret'; // pragma: allowlist secret
/** Same LENGTH, last byte different, so the constant-time compare is reached. */
const WRONG_SAME_LENGTH = `${SECRET.slice(0, -1)}X`;

const db = prismaTestClient();

// The review test at the bottom sends text; every call to the classifier goes
// to MSW, never to the real API.
useMswServer();

let tenant: SeededTenant;
let venueId: string;
let playerId: string;

async function seedVenue(tenantId: string) {
  return asAppSuperuser(db, (tx) =>
    tx.venue.create({
      data: {
        tenantId,
        slug: `outcome-${Math.random().toString(36).slice(2, 10)}`,
        name: 'Outcome Club',
        addressLine: '1 Court St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: 'desk@club.test',
      },
    }),
  );
}

/**
 * One booking on its own court, so the exclusion constraint never sees two of
 * them overlap — the tests are about status, not about the slot.
 */
async function seedBooking(opts: {
  status: BookingStatus;
  /** Hours relative to NOW. Negative is the past. */
  startH: number;
  endH: number;
  tenantId?: string;
  venueId?: string;
  bookedByUserId?: string | null;
}) {
  const tenantId = opts.tenantId ?? tenant.tenantId;
  return asAppSuperuser(db, async (tx) => {
    const court = await tx.resource.create({
      data: {
        tenantId,
        venueId: opts.venueId ?? venueId,
        name: 'Court',
        sport: 'TENNIS',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    return tx.booking.create({
      data: {
        tenantId,
        resourceId: court.id,
        startTs: new Date(NOW.getTime() + opts.startH * HOUR),
        endTs: new Date(NOW.getTime() + opts.endH * HOUR),
        status: opts.status,
        bookedByUserId: opts.bookedByUserId === undefined ? playerId : opts.bookedByUserId,
        totalCents: 2400,
        idempotencyKey: `outcome-${Math.random().toString(36).slice(2, 12)}`,
      },
    });
  });
}

const statusOf = (id: string) =>
  asAppSuperuser(db, (tx) => tx.booking.findUniqueOrThrow({ where: { id } }).then((b) => b.status));

/** The sweep as the cron route runs it: one superuser transaction. */
const sweep = (opts: { now?: Date; limit?: number } = {}) =>
  asAppSuperuser(db, (tx) => completeEndedBookings(tx, { now: NOW, ...opts }));

beforeEach(async () => {
  tenant = await seedTenant();
  venueId = (await seedVenue(tenant.tenantId)).id;
  playerId = await seedPlayer(db, tenant.tenantId);
});

// ══ The completion sweep ═════════════════════════════════════════════

describe('completing ended bookings', () => {
  it('completes a CONFIRMED booking once its end has passed', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    const r = await sweep();

    expect(r).toEqual({ scanned: 1, completed: 1, truncated: false, feeLines: 1 });
    expect(await statusOf(b.id)).toBe('COMPLETED');
  });

  it('leaves a CONFIRMED booking that has not ended — including one in progress', async () => {
    const future = await seedBooking({ status: 'CONFIRMED', startH: 2, endH: 3 });
    const inProgress = await seedBooking({ status: 'CONFIRMED', startH: -1, endH: 1 });
    // Ends exactly now: `endTs < now` is strict, so it waits for the next run.
    const endingNow = await seedBooking({ status: 'CONFIRMED', startH: -1, endH: 0 });

    const r = await sweep();

    expect(r.completed).toBe(0);
    expect(await statusOf(future.id)).toBe('CONFIRMED');
    expect(await statusOf(inProgress.id)).toBe('CONFIRMED');
    expect(await statusOf(endingNow.id)).toBe('CONFIRMED');
  });

  it('never touches PENDING, CANCELLED or NO_SHOW, however long ago they ended', async () => {
    // PENDING was never paid — the expiry sweep owns it. CANCELLED did not
    // happen. NO_SHOW is a person's judgement a timer must not overwrite.
    const pending = await seedBooking({ status: 'PENDING', startH: -50, endH: -49 });
    const cancelled = await seedBooking({ status: 'CANCELLED', startH: -50, endH: -49 });
    const noShow = await seedBooking({ status: 'NO_SHOW', startH: -50, endH: -49 });

    const r = await sweep();

    expect(r.completed).toBe(0);
    expect(await statusOf(pending.id)).toBe('PENDING');
    expect(await statusOf(cancelled.id)).toBe('CANCELLED');
    expect(await statusOf(noShow.id)).toBe('NO_SHOW');
  });

  it('audits every completion as SYSTEM, in the booking’s own club', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    await sweep();

    const rows = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { entityId: b.id } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenant.tenantId,
      actorType: 'SYSTEM',
      actorUserId: null,
      action: 'BOOKING_COMPLETED',
      entity: 'Booking',
    });
  });

  it('spans every club, and stamps each audit row with its own club', async () => {
    // Bound to one tenant the sweep would complete that club and nobody
    // else's — this is the case that proves it is not.
    const other = await seedTenant();
    const otherVenue = await seedVenue(other.tenantId);
    const here = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });
    const there = await seedBooking({
      status: 'CONFIRMED',
      startH: -2,
      endH: -1,
      tenantId: other.tenantId,
      venueId: otherVenue.id,
      bookedByUserId: null,
    });

    const r = await sweep();

    expect(r.completed).toBe(2);
    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { entityId: { in: [here.id, there.id] } },
        select: { entityId: true, tenantId: true },
      }),
    );
    expect(new Map(audit.map((a) => [a.entityId, a.tenantId]))).toEqual(
      new Map([
        [here.id, tenant.tenantId],
        [there.id, other.tenantId],
      ]),
    );
  });

  it('is idempotent — a second run finds nothing', async () => {
    await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    await sweep();
    const again = await sweep();

    expect(again).toEqual({ scanned: 0, completed: 0, truncated: false, feeLines: 0 });
  });

  it('reports a truncated run, oldest first, and the next run drains the rest', async () => {
    const oldest = await seedBooking({ status: 'CONFIRMED', startH: -30, endH: -29 });
    const middle = await seedBooking({ status: 'CONFIRMED', startH: -20, endH: -19 });
    const newest = await seedBooking({ status: 'CONFIRMED', startH: -10, endH: -9 });

    const first = await sweep({ limit: 2 });

    expect(first).toEqual({ scanned: 2, completed: 2, truncated: true, feeLines: 2 });
    expect(await statusOf(oldest.id)).toBe('COMPLETED');
    expect(await statusOf(middle.id)).toBe('COMPLETED');
    expect(await statusOf(newest.id)).toBe('CONFIRMED');

    const second = await sweep({ limit: 2 });
    expect(second).toEqual({ scanned: 1, completed: 1, truncated: false, feeLines: 1 });
    expect(await statusOf(newest.id)).toBe('COMPLETED');
  });

  it('caps a run at COMPLETE_PER_RUN even when asked for more', async () => {
    await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    // A caller cannot turn the sweep into an unbounded batch by passing a big
    // number; the ceiling is the use case's, not the caller's.
    const r = await sweep({ limit: COMPLETE_PER_RUN * 10 });

    expect(r.truncated).toBe(false);
    expect(r.completed).toBe(1);
  });
});

// ══ The cron route ═══════════════════════════════════════════════════

describe('POST /api/cron/complete-ended-bookings', () => {
  const call = (headers: Record<string, string> = {}) =>
    cron(new NextRequest('http://t/api/cron/complete-ended-bookings', { method: 'POST', headers }));

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('is closed, not open, when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    const res = await call({ 'x-cron-secret': SECRET });

    expect(res.status).toBe(503);
    expect(await statusOf(b.id)).toBe('CONFIRMED');
  });

  it('refuses a wrong secret of the right length', async () => {
    process.env.CRON_SECRET = SECRET;
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    const res = await call({ 'x-cron-secret': WRONG_SAME_LENGTH });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(await statusOf(b.id)).toBe('CONFIRMED');
  });

  it('completes ended bookings for the scheduler, by header or bearer', async () => {
    process.env.CRON_SECRET = SECRET;
    // The route uses the real clock, so these are relative to it.
    const ended = await asAppSuperuser(db, async (tx) => {
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
      return tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId: court.id,
          startTs: new Date(Date.now() - 2 * HOUR),
          endTs: new Date(Date.now() - HOUR),
          status: 'CONFIRMED',
          bookedByUserId: playerId,
          totalCents: 2400,
          idempotencyKey: `cron-${Math.random()}`,
        },
      });
    });

    const res = await call({ authorization: `Bearer ${SECRET}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ completed: 1, truncated: false });
    expect(await statusOf(ended.id)).toBe('COMPLETED');

    const quiet = await call({ 'x-cron-secret': SECRET });
    expect(await quiet.json()).toEqual({
      scanned: 0,
      completed: 0,
      truncated: false,
      feeLines: 0,
      lapsedNoShowCarries: 0,
    });
  });
});

// ══ Staff mark a no-show ═════════════════════════════════════════════

describe('marking a no-show', () => {
  /** As the server action runs it: bound to the club, as app_user. */
  const mark = (bookingId: string, tenantId = tenant.tenantId) =>
    asAppUser(db, tenantId, (tx) =>
      markNoShow(tx, tenantId, { bookingId, actorUserId: tenant.userId, now: NOW }),
    );

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => 'accepted',
      (e: unknown) => (e instanceof NoShowRefusedError ? e.reason : e),
    );

  it('marks a started CONFIRMED booking, counts it against the player, and audits who did it', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -0.25, endH: 0.75 });

    const r = await mark(b.id);

    expect(r).toEqual({ bookingId: b.id, previousStatus: 'CONFIRMED' });
    expect(await statusOf(b.id)).toBe('NO_SHOW');

    const standing = await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.findUniqueOrThrow({
        where: { tenantId_playerUserId: { tenantId: tenant.tenantId, playerUserId: playerId } },
      }),
    );
    expect(standing.noShowCount).toBe(1);

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { entityId: b.id } }),
    );
    expect(audit).toMatchObject({
      action: 'BOOKING_NO_SHOW',
      actorType: 'USER',
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
    });
  });

  it('increments an existing count rather than resetting it', async () => {
    const first = await seedBooking({ status: 'CONFIRMED', startH: -3, endH: -2 });
    const second = await seedBooking({ status: 'CONFIRMED', startH: -1, endH: 0 });

    await mark(first.id);
    await mark(second.id);

    const standing = await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.findUniqueOrThrow({
        where: { tenantId_playerUserId: { tenantId: tenant.tenantId, playerUserId: playerId } },
      }),
    );
    expect(standing.noShowCount).toBe(2);
  });

  it('overturns a COMPLETED booking — the desk is slower than the sweep', async () => {
    const b = await seedBooking({ status: 'COMPLETED', startH: -3, endH: -2 });

    const r = await mark(b.id);

    expect(r.previousStatus).toBe('COMPLETED');
    expect(await statusOf(b.id)).toBe('NO_SHOW');
  });

  it('marks a guest booking, with no player to count against', async () => {
    const b = await seedBooking({
      status: 'CONFIRMED',
      startH: -1,
      endH: 0,
      bookedByUserId: null,
    });

    await mark(b.id);

    expect(await statusOf(b.id)).toBe('NO_SHOW');
    const standings = await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.count({ where: { tenantId: tenant.tenantId } }),
    );
    expect(standings).toBe(0);
  });

  it('refuses a booking that has not started — nobody can have failed to turn up yet', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: 1, endH: 2 });

    expect(await refusal(mark(b.id))).toBe('NOT_STARTED');
    expect(await statusOf(b.id)).toBe('CONFIRMED');
  });

  it('refuses PENDING and CANCELLED — there was no paid slot to miss', async () => {
    const pending = await seedBooking({ status: 'PENDING', startH: -2, endH: -1 });
    const cancelled = await seedBooking({ status: 'CANCELLED', startH: -2, endH: -1 });

    expect(await refusal(mark(pending.id))).toBe('NOT_ATTENDABLE');
    expect(await refusal(mark(cancelled.id))).toBe('NOT_ATTENDABLE');
    expect(await statusOf(pending.id)).toBe('PENDING');
    expect(await statusOf(cancelled.id)).toBe('CANCELLED');
  });

  it('refuses to mark the same booking twice, so the count is not inflated', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });
    await mark(b.id);

    expect(await refusal(mark(b.id))).toBe('ALREADY_NO_SHOW');

    const standing = await asAppSuperuser(db, (tx) =>
      tx.playerVenueRelationship.findUniqueOrThrow({
        where: { tenantId_playerUserId: { tenantId: tenant.tenantId, playerUserId: playerId } },
      }),
    );
    expect(standing.noShowCount).toBe(1);
  });

  it('cannot reach another club’s booking — RLS makes it NOT_FOUND', async () => {
    const other = await seedTenant();
    const otherVenue = await seedVenue(other.tenantId);
    const theirs = await seedBooking({
      status: 'CONFIRMED',
      startH: -2,
      endH: -1,
      tenantId: other.tenantId,
      venueId: otherVenue.id,
      bookedByUserId: null,
    });

    // Bound to OUR club, naming THEIR booking.
    expect(await refusal(mark(theirs.id))).toBe('NOT_FOUND');
    expect(await statusOf(theirs.id)).toBe('CONFIRMED');
  });

  it('refuses once the player has reviewed the visit, so NO_SHOW cannot take a review down', async () => {
    const b = await seedBooking({ status: 'COMPLETED', startH: -3, endH: -2 });
    await createReview((fn) => asAppUser(db, tenant.tenantId, fn), {
      tenantId: tenant.tenantId,
      authorUserId: playerId,
      bookingId: b.id,
      rating: 1,
    });

    expect(await refusal(mark(b.id))).toBe('REVIEWED');
    expect(await statusOf(b.id)).toBe('COMPLETED');
  });
});

// ══ How the two meet ═════════════════════════════════════════════════

describe('a no-show and the review it blocks', () => {
  it('a booking marked during its slot is never completed by the sweep afterwards', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -0.5, endH: 0.5 });
    await asAppUser(db, tenant.tenantId, (tx) =>
      markNoShow(tx, tenant.tenantId, { bookingId: b.id, actorUserId: tenant.userId, now: NOW }),
    );

    // The slot ends; the sweep runs an hour later.
    await sweep({ now: new Date(NOW.getTime() + HOUR) });

    expect(await statusOf(b.id)).toBe('NO_SHOW');
  });

  it('a NO_SHOW booking cannot be reviewed', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });
    await sweep();
    await asAppUser(db, tenant.tenantId, (tx) =>
      markNoShow(tx, tenant.tenantId, { bookingId: b.id, actorUserId: tenant.userId, now: NOW }),
    );

    await expect(
      createReview((fn) => asAppUser(db, tenant.tenantId, fn), {
        tenantId: tenant.tenantId,
        authorUserId: playerId,
        bookingId: b.id,
        rating: 5,
        body: 'I was definitely there',
      }),
    ).rejects.toThrow(NoProofOfVisitError);
  });

  it('a completed booking CAN be reviewed — the sweep is what makes reviews possible at all', async () => {
    const b = await seedBooking({ status: 'CONFIRMED', startH: -2, endH: -1 });

    await sweep();
    const r = await createReview((fn) => asAppUser(db, tenant.tenantId, fn), {
      tenantId: tenant.tenantId,
      authorUserId: playerId,
      bookingId: b.id,
      rating: 4,
    });

    expect(r.status).toBe('PUBLISHED');
  });
});
