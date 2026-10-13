import type { PrismaClient } from '@prisma/client';

import { pgErrorCode } from '@/lib/db/pg-errors';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The double-booking defence, proven.
 *
 * These tests are the reason `createBooking` is allowed to be naive. The
 * app layer does NOT check "is this slot free?" — under concurrency that
 * check always loses (two requests both read free, both write, both
 * succeed, the court is sold twice). It attempts the INSERT and catches
 * 23P01.
 *
 * If these tests were wrong, that design would be catastrophic. So they
 * assert the Postgres error CODE, not just "it threw" — a NOT NULL
 * violation also throws, and would let a broken constraint pass silently.
 */

const HOUR = 3_600_000;

async function expectPgError(promise: Promise<unknown>, code: string, what: string) {
  let thrown: unknown;
  try {
    await promise;
  } catch (e) {
    thrown = e;
  }

  if (thrown === undefined) {
    throw new Error(`Expected ${what} to be rejected with SQLSTATE ${code}, but it SUCCEEDED.`);
  }

  const actual = pgErrorCode(thrown);
  if (actual !== code) {
    throw new Error(
      `Expected SQLSTATE ${code} (${what}), got ${actual ?? 'no code'}.\n` +
        `A different error means the constraint under test may not be the one that fired.\n` +
        `Original: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
}

describe('booking exclusion constraint', () => {
  const prisma = prismaTestClient();

  let t: SeededTenant;
  let resourceA: string;
  let resourceB: string;
  let venueId: string;

  /** Two bookings on the same court, back-to-back or overlapping. */
  const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR);

  async function makeBooking(
    tx: PrismaClient,
    opts: {
      resourceId?: string;
      start: Date;
      end: Date;
      status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
      key?: string;
    },
  ) {
    return tx.booking.create({
      data: {
        tenantId: t.tenantId,
        resourceId: opts.resourceId ?? resourceA,
        startTs: opts.start,
        endTs: opts.end,
        status: opts.status ?? 'CONFIRMED',
        totalCents: 2400,
        idempotencyKey: opts.key ?? `key-${Math.random().toString(36).slice(2)}`,
      },
    });
  }

  beforeEach(async () => {
    t = await seedTenant({ name: 'Sofia Padel Club' });

    await asAppSuperuser(prisma, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug: 'sofia-padel',
          name: 'Sofia Padel',
          addressLine: 'ul. Test 1',
          city: 'Sofia',
          email: 'v@playerz.test',
          lat: 42.6977,
          lng: 23.3219,
        },
      });
      venueId = venue.id;

      const [a, b] = await Promise.all([
        tx.resource.create({
          data: {
            tenantId: t.tenantId,
            venueId: venue.id,
            name: 'Court 1',
            sport: 'PADEL',
            surface: 'ARTIFICIAL_GRASS',
            basePriceCents: 2400,
          },
        }),
        tx.resource.create({
          data: {
            tenantId: t.tenantId,
            venueId: venue.id,
            name: 'Court 2',
            sport: 'PADEL',
            surface: 'ARTIFICIAL_GRASS',
            basePriceCents: 2400,
          },
        }),
      ]);
      resourceA = a.id;
      resourceB = b.id;
    });
  });

  it('1. two overlapping CONFIRMED bookings on one court — the second is rejected with 23P01', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await makeBooking(tx, { start: at(24), end: at(25) });

      await expectPgError(
        makeBooking(tx, { start: at(24.5), end: at(25.5) }),
        '23P01',
        'an overlapping CONFIRMED booking',
      );
    });
  });

  it('2. a CANCELLED booking frees its slot — the overlapping booking succeeds', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await makeBooking(tx, { start: at(24), end: at(25), status: 'CANCELLED' });

      // The constraint's WHERE clause excludes CANCELLED. If it did not, a
      // cancelled booking would hold its court hostage forever.
      const second = await makeBooking(tx, { start: at(24), end: at(25), status: 'CONFIRMED' });
      expect(second.id).toBeTruthy();
    });
  });

  it('3. the same time on a DIFFERENT court is fine', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await makeBooking(tx, { resourceId: resourceA, start: at(24), end: at(25) });
      const second = await makeBooking(tx, { resourceId: resourceB, start: at(24), end: at(25) });
      expect(second.resourceId).toBe(resourceB);
    });
  });

  it('4. back-to-back bookings do NOT overlap — the range is half-open [)', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await makeBooking(tx, { start: at(24), end: at(25) });

      // [24,25) and [25,26) share only the instant 25:00, which the
      // half-open range excludes. A closed `[]` range would reject this —
      // and back-to-back slots are the NORMAL case at any club.
      const second = await makeBooking(tx, { start: at(25), end: at(26) });
      expect(second.id).toBeTruthy();
    });
  });

  it('5. a PENDING booking still holds the slot', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await makeBooking(tx, { start: at(24), end: at(25), status: 'PENDING' });

      // Someone is at checkout. The slot is not free — that is exactly why
      // Booking.expiresAt exists, so an abandoned checkout releases it.
      await expectPgError(
        makeBooking(tx, { start: at(24), end: at(25), status: 'CONFIRMED' }),
        '23P01',
        'a booking overlapping a PENDING one',
      );
    });
  });

  // 6. A coach cannot be double-booked either: that is `coach_lesson_no_overlap`
  //    since P71, on the coach's account and across clubs. It has its own
  //    suite, tests/integration/coach-tables.test.ts.

  it('7. a booking longer than 4 hours is rejected by the CHECK constraint', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await expectPgError(
        makeBooking(tx, { start: at(24), end: at(29) }),
        '23514',
        'a 5-hour booking',
      );
    });
  });

  it('8. a booking that ends before it starts is rejected', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await expectPgError(
        makeBooking(tx, { start: at(25), end: at(24) }),
        '23514',
        'an inverted booking span',
      );
    });
  });

  it('9. the same idempotencyKey twice on one tenant is rejected', async () => {
    await asAppSuperuser(prisma, async (tx) => {
      await makeBooking(tx, { start: at(24), end: at(25), key: 'same-key' });

      // The difference between a flaky network and a double charge.
      await expectPgError(
        makeBooking(tx, { resourceId: resourceB, start: at(30), end: at(31), key: 'same-key' }),
        '23505',
        'a duplicate idempotency key',
      );
    });
  });

  it('10. the exclusion constraints actually exist in pg_constraint', async () => {
    // Guards against the whole suite passing because the constraints were
    // never created and every INSERT simply succeeded.
    const rows = await asAppSuperuser(prisma, (tx) =>
      tx.$queryRawUnsafe<Array<{ conname: string }>>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE '%no_overlap%' ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.conname)).toEqual(['booking_no_overlap', 'coach_lesson_no_overlap']);
    expect(venueId).toBeTruthy();
  });
});
