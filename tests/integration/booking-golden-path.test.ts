import type { PrismaClient } from '@prisma/client';

import { appendEntry, getBalance, spendCredit } from '@/app-layer/usecases/wallet';
import {
  BookingNotCancellableError,
  SlotTakenError,
  cancelBooking,
  createBooking,
} from '@/app-layer/usecases/booking';
import { releaseExpiredBookings } from '@/app-layer/usecases/release-expired-bookings';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

const HOUR = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * HOUR);

describe('booking golden path', () => {
  const prisma = prismaTestClient();
  let t: SeededTenant;
  let resourceId: string;

  beforeEach(async () => {
    t = await seedTenant();
    await asAppSuperuser(prisma, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: t.tenantId,
          slug: 'sofia-padel',
          name: 'Sofia Padel',
          addressLine: '1',
          city: 'Sofia',
          email: 'v@playerz.test',
          lat: 42.7,
          lng: 23.3,
        },
      });
      const court = await tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'ARTIFICIAL_GRASS',
          basePriceCents: 2400,
        },
      });
      resourceId = court.id;
    });
  });

  const mk = (db: PrismaClient, o: Partial<Parameters<typeof createBooking>[2]> = {}) =>
    createBooking(db, t.tenantId, {
      resourceId,
      startTs: at(24),
      endTs: at(25),
      totalCents: 2400,
      idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
      bookedByUserId: t.userId,
      ...o,
    });

  it('creates a PENDING booking with a 15-minute expiry', async () => {
    const r = await asAppSuperuser(prisma, (tx) => mk(tx));

    expect(r.status).toBe('PENDING');
    expect(r.idempotentReplay).toBe(false);

    // A PENDING booking HOLDS the slot (the EXCLUDE constraint counts it).
    // Without the expiry, an abandoned checkout holds the court forever.
    const ttl = r.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
  });

  it('a repeated idempotencyKey returns the ORIGINAL booking, not a second one', async () => {
    const key = 'stable-key';

    const first = await asAppSuperuser(prisma, (tx) => mk(tx, { idempotencyKey: key }));
    const second = await asAppSuperuser(prisma, (tx) => mk(tx, { idempotencyKey: key }));

    // The difference between a flaky mobile network and a double charge:
    // the user tapped once, the request timed out, the app retried. They
    // must end up with ONE booking — and not an error page in front of a
    // booking that actually succeeded.
    expect(second.bookingId).toBe(first.bookingId);
    expect(second.idempotentReplay).toBe(true);

    const count = await asAppSuperuser(prisma, (tx) => tx.booking.count());
    expect(count).toBe(1);
  });

  it('TWO CONCURRENT bookings for one slot: exactly one wins, cleanly', async () => {
    // What this DOES prove: two transactions racing inside Postgres produce
    // one booking and one SlotTakenError, and the 23P01 from the exclusion
    // constraint is mapped all the way out to a domain error rather than
    // escaping as a raw 500. Both promises are started before either is
    // awaited, so they really do overlap.
    //
    // What it does NOT prove, checked rather than assumed: every assertion
    // below is produced by the `booking_no_overlap` EXCLUDE constraint, which
    // stays in the schema no matter what the application does. Give
    // `createBooking` the check-then-insert anti-pattern its own header
    // forbids — a findFirst overlap pre-check before the insert — and this
    // test stays green.
    //
    // It was titled "THE test", and said it was the scenario a check-then-
    // insert implementation fails on a busy Saturday. It is not, and cannot
    // be: the outcome is identical either way, so no assertion on the outcome
    // can tell them apart. Its sibling in api-v1-bookings.test.ts had already
    // been corrected to say exactly this; this one was left claiming the
    // opposite, so the repo held two contradictory answers and the false one
    // was the one labelled definitive.
    //
    // The guarantee lives where it can actually be checked:
    // `booking-exclusion.test.ts` asserts booking_no_overlap exists in the
    // live schema, and `migration-safety` fails any migration that drops it.
    const a = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      return mk(tx as unknown as PrismaClient, { idempotencyKey: 'race-a' });
    });
    const b = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      return mk(tx as unknown as PrismaClient, { idempotencyKey: 'race-b' });
    });

    const results = await Promise.allSettled([a, b]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser must get a clean domain error, not a raw Postgres 500.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(SlotTakenError);
    expect((err as SlotTakenError).code).toBe('slot_taken');

    // And the database really does hold exactly one.
    const count = await asAppSuperuser(prisma, (tx) => tx.booking.count());
    expect(count).toBe(1);
  });

  it('the idempotency pre-check runs BEFORE the insert, not as error recovery', async () => {
    // Regression pin for a bug that only appears on a real retry.
    //
    // The obvious implementation catches the unique violation and then
    // re-reads the original row. That CANNOT work: a constraint violation
    // ABORTS the Postgres transaction, so the recovery read fails with
    // "current transaction is aborted" — a second, more confusing error on
    // top of the first. The user taps Book once, the network stalls, the app
    // retries, and they get a 500 while their booking actually exists.
    //
    // Proof the pre-check is what handles it: a replay inside a transaction
    // that is STILL USABLE afterwards. If recovery-by-catch had been used,
    // the transaction would be poisoned and this follow-up query would throw.
    const key = 'pre-check-key';
    await asAppSuperuser(prisma, (tx) => mk(tx, { idempotencyKey: key }));

    const stillUsable = await asAppSuperuser(prisma, async (tx) => {
      const replay = await mk(tx, { idempotencyKey: key });
      expect(replay.idempotentReplay).toBe(true);
      // The transaction is healthy — this would throw if the replay had gone
      // through a constraint violation.
      return tx.booking.count();
    });

    expect(stillUsable).toBe(1);
  });

  it('a sequential overlapping booking is rejected with slot_taken', async () => {
    await asAppSuperuser(prisma, (tx) => mk(tx));

    await expect(
      asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(24.5), endTs: at(25.5) })),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('a booking with no user and no guest contact is refused', async () => {
    // Nobody to confirm, remind, or refund is not a booking — it is a slot
    // that quietly disappears.
    await expect(
      asAppSuperuser(prisma, (tx) => mk(tx, { bookedByUserId: null, guestContact: null })),
    ).rejects.toThrow(/attributable to someone/);
  });

  it('a GUEST booking is a first-class flow', async () => {
    const r = await asAppSuperuser(prisma, (tx) =>
      mk(tx, {
        bookedByUserId: null,
        guestContact: { name: 'Ivan', email: 'ivan@example.com', phone: '+359888' },
      }),
    );

    const row = await asAppSuperuser(prisma, (tx) =>
      tx.booking.findUniqueOrThrow({ where: { id: r.bookingId } }),
    );
    expect(row.guestEmail).toBe('ivan@example.com');
    expect(row.bookedByUserId).toBeNull();
  });

  describe('cancellation', () => {
    describe('the wallet leg', () => {
      // `checkoutBooking` spends the wallet BEFORE charging the card, so a
      // part-paid booking cancelled at 100% used to give back the card money
      // and silently keep the credit. The receipt quoted a full refund while
      // `REFUND_CREDIT` was written by nothing in src/.

      const giveCredit = (userId: string, cents: number) =>
        appendEntry(prisma, {
          tenantId: t.tenantId,
          userId,
          deltaCents: cents,
          reason: 'ADMIN_ADJUST',
        });

      const balance = (userId: string) => getBalance(prisma, { tenantId: t.tenantId, userId });

      it('returns the SAME percentage of credit as of card', async () => {
        await giveCredit(t.userId, 1000);
        // 20h out → the 50% tier.
        const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(20), endTs: at(21) }));

        await spendCredit(prisma, {
          tenantId: t.tenantId,
          userId: t.userId,
          amountCents: 2400,
          bookingId: b.bookingId,
        });
        expect(await balance(t.userId)).toBe(0);

        const res = await cancelBooking(prisma, t.tenantId, {
          bookingId: b.bookingId,
          cancelledByUserId: t.userId,
        });

        expect(res.refundPercent).toBe(50);
        expect(res.refundCreditCents).toBe(500);
        expect(await balance(t.userId)).toBe(500);

        // And it is ON THE RECEIPT, not merely in the ledger — the two legs
        // settle through different systems and have to be reconcilable.
        const receipt = await asAppSuperuser(prisma, (tx) =>
          tx.cancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } }),
        );
        expect(receipt.refundCreditCents).toBe(500);
        expect(receipt.refundAmountCents).toBe(1200);
      });

      it('forfeits the credit when the card is forfeited', async () => {
        // The arbitrage this closes: returning credit in full while keeping
        // card money would make paying by wallet strictly better than paying
        // by card, which is not a discount the club agreed to.
        await giveCredit(t.userId, 1000);
        const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(6), endTs: at(7) }));

        await spendCredit(prisma, {
          tenantId: t.tenantId,
          userId: t.userId,
          amountCents: 2400,
          bookingId: b.bookingId,
        });

        const res = await cancelBooking(prisma, t.tenantId, { bookingId: b.bookingId });

        expect(res.refundPercent).toBe(0);
        expect(res.refundCreditCents).toBe(0);
        expect(await balance(t.userId)).toBe(0);

        const refunds = await asAppSuperuser(prisma, (tx) =>
          tx.creditLedgerEntry.findMany({
            where: { refId: b.bookingId, reason: 'REFUND_CREDIT' },
          }),
        );
        expect(refunds).toHaveLength(0);
      });

      it('writes no ledger entry for a booking paid entirely by card', async () => {
        // The inverse lie. A REFUND_CREDIT entry for credit never spent is the
        // same class of error as the receipt that used to keep it.
        const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(48), endTs: at(49) }));

        const res = await cancelBooking(prisma, t.tenantId, { bookingId: b.bookingId });

        expect(res.refundPercent).toBe(100);
        expect(res.refundCreditCents).toBe(0);

        const entries = await asAppSuperuser(prisma, (tx) =>
          tx.creditLedgerEntry.findMany({ where: { refId: b.bookingId } }),
        );
        expect(entries).toHaveLength(0);
      });
    });

    it('> 24h out → 100% refund, written onto the receipt', async () => {
      const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(48), endTs: at(49) }));

      const res = await asAppSuperuser(prisma, (tx) =>
        cancelBooking(tx, t.tenantId, { bookingId: b.bookingId, cancelledByUserId: t.userId }),
      );

      expect(res.refundPercent).toBe(100);
      expect(res.refundAmountCents).toBe(2400);

      // The resolved percentage is STORED. The venue's policy may change
      // next month; this receipt must not.
      const receipt = await asAppSuperuser(prisma, (tx) =>
        tx.cancellation.findUniqueOrThrow({ where: { bookingId: b.bookingId } }),
      );
      expect(receipt.refundPercent).toBe(100);
      expect(receipt.refundAmountCents).toBe(2400);
    });

    it('12–24h out → 50% refund', async () => {
      const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(20), endTs: at(21) }));

      const res = await asAppSuperuser(prisma, (tx) =>
        cancelBooking(tx, t.tenantId, { bookingId: b.bookingId }),
      );
      expect(res.refundPercent).toBe(50);
      expect(res.refundAmountCents).toBe(1200);
    });

    it('< 12h out → no refund', async () => {
      const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(6), endTs: at(7) }));

      const res = await asAppSuperuser(prisma, (tx) =>
        cancelBooking(tx, t.tenantId, { bookingId: b.bookingId }),
      );
      expect(res.refundPercent).toBe(0);
    });

    it('loses to the expiry sweeper, and writes NO refund receipt', async () => {
      // The ledger lie this fix exists to prevent.
      //
      // The sweeper releases an expired hold and deliberately writes no
      // Cancellation row, because no money was ever taken. If a cancel racing
      // it still wrote one, the books would carry a refund receipt — up to a
      // FULL refund, since this booking starts >24h out — against a booking
      // that was never paid for.
      const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(48), endTs: at(49) }));

      // Backdate the hold so the sweeper is entitled to it, exactly as a
      // booking sitting unpaid for 15 minutes would be.
      await asAppSuperuser(prisma, (tx) =>
        tx.booking.update({
          where: { id: b.bookingId },
          data: { expiresAt: new Date(Date.now() - HOUR) },
        }),
      );

      const swept = await releaseExpiredBookings(prisma);
      expect(swept.released).toBeGreaterThanOrEqual(1);

      await expect(
        asAppSuperuser(prisma, (tx) =>
          cancelBooking(tx, t.tenantId, { bookingId: b.bookingId, cancelledByUserId: t.userId }),
        ),
      ).rejects.toBeInstanceOf(BookingNotCancellableError);

      const receipt = await asAppSuperuser(prisma, (tx) =>
        tx.cancellation.findUnique({ where: { bookingId: b.bookingId } }),
      );
      expect(receipt).toBeNull();
    });

    it("does not overwrite the sweeper's cancelledAt with a later one", async () => {
      // The loser must write NOTHING — not "nothing important". An overwritten
      // cancelledAt moves the booking's recorded end by however long the race
      // took, and that timestamp is what a dispute is argued from.
      const b = await asAppSuperuser(prisma, (tx) => mk(tx));

      const sweptAt = new Date(Date.now() - 5 * HOUR);
      await asAppSuperuser(prisma, (tx) =>
        tx.booking.update({
          where: { id: b.bookingId },
          // Lapsed BEFORE the sweep ran — otherwise the sweeper skips it and
          // the test would be asserting against a booking nobody touched.
          data: { expiresAt: new Date(sweptAt.getTime() - HOUR) },
        }),
      );

      const swept = await releaseExpiredBookings(prisma, { now: sweptAt });
      expect(swept.released).toBeGreaterThanOrEqual(1);

      await expect(
        asAppSuperuser(prisma, (tx) => cancelBooking(tx, t.tenantId, { bookingId: b.bookingId })),
      ).rejects.toBeInstanceOf(BookingNotCancellableError);

      const row = await asAppSuperuser(prisma, (tx) =>
        tx.booking.findUniqueOrThrow({ where: { id: b.bookingId } }),
      );
      expect(row.cancelledAt?.getTime()).toBe(sweptAt.getTime());
    });

    it('a second cancel is a 409, not a bare INTERNAL', async () => {
      // Before the fix this escaped as a raw unique violation on
      // `cancellation_bookingId_key`: only createBooking mapped that, so a
      // double-tap on Cancel surfaced to the client as a 500.
      const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(48), endTs: at(49) }));

      await asAppSuperuser(prisma, (tx) =>
        cancelBooking(tx, t.tenantId, { bookingId: b.bookingId }),
      );

      await expect(
        asAppSuperuser(prisma, (tx) => cancelBooking(tx, t.tenantId, { bookingId: b.bookingId })),
      ).rejects.toBeInstanceOf(BookingNotCancellableError);

      const receipts = await asAppSuperuser(prisma, (tx) =>
        tx.cancellation.findMany({ where: { bookingId: b.bookingId } }),
      );
      expect(receipts).toHaveLength(1);
    });

    it('maps a stray Cancellation row to the 409 rather than a raw 23505', async () => {
      // The status predicate closes the ordinary double-tap, so this backstop
      // is not reachable through it — which is exactly why it needs its own
      // test, or it is unverified code that only runs on the day something
      // else has already gone wrong.
      //
      // The state it guards: a Cancellation row exists while the booking is
      // still live. Then the UPDATE matches, and the receipt INSERT is what
      // raises. Unmapped, that reached the client as a 500.
      const b = await asAppSuperuser(prisma, (tx) => mk(tx, { startTs: at(48), endTs: at(49) }));

      await asAppSuperuser(prisma, (tx) =>
        tx.cancellation.create({
          data: {
            tenantId: t.tenantId,
            bookingId: b.bookingId,
            refundPercent: 100,
            refundAmountCents: 2400,
          },
        }),
      );

      await expect(
        asAppSuperuser(prisma, (tx) => cancelBooking(tx, t.tenantId, { bookingId: b.bookingId })),
      ).rejects.toBeInstanceOf(BookingNotCancellableError);
    });

    it('cancelling FREES the slot for someone else', async () => {
      const first = await asAppSuperuser(prisma, (tx) => mk(tx));

      await asAppSuperuser(prisma, (tx) =>
        cancelBooking(tx, t.tenantId, { bookingId: first.bookingId }),
      );

      // The EXCLUDE constraint's WHERE clause excludes CANCELLED. Without
      // it, a cancellation would hold the court hostage forever.
      const second = await asAppSuperuser(prisma, (tx) => mk(tx));
      expect(second.bookingId).not.toBe(first.bookingId);
    });
  });
});
