import { NextRequest } from 'next/server';

import { POST as cron } from '@/app/api/cron/release-expired-bookings/route';
import { releaseExpiredBookings } from '@/app-layer/usecases/release-expired-bookings';
import { appendEntry, getBalance, spendCredit } from '@/app-layer/usecases/wallet';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Releasing abandoned checkouts — against a real database.
 *
 * `Booking.expiresAt` has been written on every booking since P05 and read by
 * NOTHING, so a player who opened checkout and closed the tab held a court for
 * ever. The exclusion constraint counts PENDING as occupying a slot, and the
 * availability endpoint mirrors it exactly, so those holds were invisible too.
 */
describe('releasing expired PENDING bookings', () => {
  const db = prismaTestClient();

  // Fixture only: never a real credential, and the scanner is right to ask.
  // Same treatment as TEST_WEBHOOK_SECRET in tests/helpers/stripe-webhook.ts.
  const SECRET = 'cron-fixture-not-a-real-secret'; // pragma: allowlist secret

  let tenant: SeededTenant;
  let resourceId: string;

  beforeEach(async () => {
    process.env.CRON_SECRET = SECRET;
    tenant = await seedTenant({});

    resourceId = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `sweep-${Date.now()}`,
          name: 'Sweep Club',
          description: 'Courts',
          addressLine: '1 St',
          city: 'Sofia',
          email: 'i@c.test',
          phone: '+359',
          lat: 42.69,
          lng: 23.32,
        },
      });
      const r = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: venue.id,
          name: 'Court 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      return r.id;
    });
  });

  const makeBooking = (opts: {
    status?: 'PENDING' | 'CONFIRMED';
    expiresAt?: Date | null;
    hour?: number;
    bookedByUserId?: string;
  }) =>
    asAppSuperuser(db, (tx) =>
      tx.booking
        .create({
          data: {
            tenantId: tenant.tenantId,
            resourceId,
            bookedByUserId: opts.bookedByUserId ?? null,
            startTs: new Date(`2026-10-0${opts.hour ?? 1}T08:00:00Z`),
            endTs: new Date(`2026-10-0${opts.hour ?? 1}T09:00:00Z`),
            status: opts.status ?? 'PENDING',
            totalCents: 2400,
            idempotencyKey: `sw-${Math.random()}`,
            expiresAt:
              opts.expiresAt === undefined ? new Date(Date.now() - 60_000) : opts.expiresAt,
          },
        })
        .then((b) => b.id),
    );

  const statusOf = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.booking.findFirstOrThrow({ where: { id } }).then((b) => b.status),
    );

  const sweep = () => releaseExpiredBookings(db);

  it('releases a booking whose checkout window has passed', async () => {
    const id = await makeBooking({});

    const r = await sweep();

    expect(r.released).toBe(1);
    expect(await statusOf(id)).toBe('CANCELLED');
  });

  it('audits it as SYSTEM, not as somebody cancelling', async () => {
    await makeBooking({});
    await sweep();

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'BOOKING_EXPIRED', actorType: 'SYSTEM' });
  });

  it('frees the slot for a new booking', async () => {
    // The whole point. Until this ran, the exclusion constraint kept rejecting
    // anyone else who wanted that court.
    await makeBooking({});
    await sweep();

    const replacement = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date('2026-10-01T08:00:00Z'),
          endTs: new Date('2026-10-01T09:00:00Z'),
          status: 'PENDING',
          totalCents: 2400,
          idempotencyKey: `new-${Math.random()}`,
        },
      }),
    );

    expect(replacement.id).toBeTruthy();
  });

  it('leaves a booking whose window has NOT passed', async () => {
    const id = await makeBooking({ expiresAt: new Date(Date.now() + 600_000) });

    expect((await sweep()).released).toBe(0);
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('NEVER touches a CONFIRMED booking, even with a stale expiresAt', async () => {
    // A paid booking with a leftover expiry must not be cancelled by a timer.
    // This is the failure that would take money and then remove the court.
    const id = await makeBooking({ status: 'CONFIRMED', hour: 2 });

    expect((await sweep()).released).toBe(0);
    expect(await statusOf(id)).toBe('CONFIRMED');
  });

  it('ignores a booking with no expiry at all', async () => {
    const id = await makeBooking({ expiresAt: null, hour: 3 });

    expect((await sweep()).released).toBe(0);
    expect(await statusOf(id)).toBe('PENDING');
  });

  it('does not write a Cancellation receipt — there was nothing to refund', async () => {
    // Deliberately not routed through cancelBooking, which quotes a refund. A
    // refund receipt for money never taken would be a lie in the ledger.
    await makeBooking({});
    await sweep();

    const cancellations = await asAppSuperuser(db, (tx) =>
      tx.cancellation.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(cancellations).toHaveLength(0);
  });

  it('is idempotent — a second sweep releases nothing', async () => {
    await makeBooking({});

    expect((await sweep()).released).toBe(1);
    expect((await sweep()).released).toBe(0);
  });

  describe('the endpoint, which nothing else guards', () => {
    const call = (headers: Record<string, string>) =>
      cron(
        new NextRequest('http://t/api/cron/release-expired-bookings', { method: 'POST', headers }),
      );

    it('runs with the right secret', async () => {
      await makeBooking({});

      const res = await call({ 'x-cron-secret': SECRET });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ released: 1 });
    });

    it('accepts the Bearer form a scheduler sends', async () => {
      const res = await call({ authorization: `Bearer ${SECRET}` });
      expect(res.status).toBe(200);
    });

    it('401s on a wrong secret', async () => {
      const id = await makeBooking({});

      const res = await call({ 'x-cron-secret': 'wrong-but-same-length!!' });

      expect(res.status).toBe(401);
      // And nothing ran.
      expect(await statusOf(id)).toBe('PENDING');
    });

    it('401s with no secret at all', async () => {
      expect((await call({})).status).toBe(401);
    });

    it('503s — never runs — when CRON_SECRET is unset', async () => {
      // THE inversion this must not have: "no credential configured, therefore
      // no check". That is how an internal endpoint ends up open on the day
      // somebody forgets an env var.
      delete process.env.CRON_SECRET;
      const id = await makeBooking({});

      const res = await call({ 'x-cron-secret': 'anything' });

      expect(res.status).toBe(503);
      expect(await statusOf(id)).toBe('PENDING');

      process.env.CRON_SECRET = SECRET;
    });

    it('answers in the canonical error envelope', async () => {
      // A scheduler is a client too, and a bare string where every other route
      // returns a struct is what api-error-envelope exists to prevent.
      const res = await call({});
      const body = (await res.json()) as { error: { code: string; message: string } };

      expect(body.error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(typeof body.error.message).toBe('string');
    });
  });

  describe('wallet credit spent on a booking that never happened', () => {
    // The sweep's header used to say "there is nothing to refund". It was
    // wrong: `checkoutBooking` spends the wallet BEFORE charging the card, and
    // the booking stays PENDING for the whole card leg. Abandon the card step
    // and the credit was simply gone.

    const creditOf = (userId: string) => getBalance(db, { tenantId: tenant.tenantId, userId });

    const giveCredit = (userId: string, cents: number) =>
      appendEntry(db, {
        tenantId: tenant.tenantId,
        userId,
        deltaCents: cents,
        reason: 'ADMIN_ADJUST',
      });

    it('hands the credit back when it releases the slot', async () => {
      const player = await seedPlayer(db, tenant.tenantId, 'sweep-refund');
      await giveCredit(player, 1000);

      const id = await makeBooking({ bookedByUserId: player });

      // What checkout does: wallet first, card for the rest. 1000 of the 2400
      // is taken, 1400 is left on the card, and the booking stays PENDING.
      const spent = await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: player,
        amountCents: 2400,
        bookingId: id,
      });
      expect(spent.walletAppliedCents).toBe(1000);
      expect(spent.cardDueCents).toBe(1400);
      expect(await creditOf(player)).toBe(0);

      const r = await sweep();

      expect(r.released).toBe(1);
      expect(r.creditRefundedCents).toBe(1000);
      expect(await statusOf(id)).toBe('CANCELLED');

      // Back where it started — and by a compensating ENTRY, not by editing
      // the spend. The ledger is append-only; both facts stay on the record.
      expect(await creditOf(player)).toBe(1000);

      const entries = await asAppSuperuser(db, (tx) =>
        tx.creditLedgerEntry.findMany({
          where: { refType: 'booking', refId: id },
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(entries.map((e) => [e.reason, e.deltaCents])).toEqual([
        ['SPEND', -1000],
        ['REFUND_CREDIT', 1000],
      ]);
    });

    it('writes no ledger entry when the wallet was never touched', async () => {
      // The inverse lie. A refund entry for money never taken is exactly the
      // thing the original comment was right to refuse.
      const player = await seedPlayer(db, tenant.tenantId, 'sweep-nocredit');
      const id = await makeBooking({ bookedByUserId: player });

      const r = await sweep();

      expect(r.released).toBe(1);
      expect(r.creditRefundedCents).toBe(0);

      const entries = await asAppSuperuser(db, (tx) =>
        tx.creditLedgerEntry.findMany({ where: { refType: 'booking', refId: id } }),
      );
      expect(entries).toHaveLength(0);
    });

    it('returns each wallet its own share of a split booking', async () => {
      // A lump sum back to the booker would be a second, quieter way to lose
      // money — right total, wrong pockets.
      const a = await seedPlayer(db, tenant.tenantId, 'split-a');
      const b = await seedPlayer(db, tenant.tenantId, 'split-b');
      await giveCredit(a, 400);
      await giveCredit(b, 900);

      const id = await makeBooking({ bookedByUserId: a });

      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: a,
        amountCents: 400,
        bookingId: id,
      });
      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: b,
        amountCents: 900,
        bookingId: id,
      });

      const r = await sweep();
      expect(r.creditRefundedCents).toBe(1300);

      expect(await creditOf(a)).toBe(400);
      expect(await creditOf(b)).toBe(900);
    });

    it('refunds nothing when it loses the race it was already scanning', async () => {
      // The deterministic version of the race, and the only test that reaches
      // `updated.count === 0`. Two sweeps started with Promise.all do NOT
      // reliably interleave — the second usually scans after the first has
      // committed, finds nothing, and never enters the loop at all.
      //
      // So the row is pinned instead. The sweep scans (MVCC, not blocked),
      // sees PENDING, and its UPDATE queues behind our lock. We then confirm
      // the booking and commit. The sweep wakes to a booking that is no longer
      // PENDING and must return having refunded nothing — this player paid and
      // is getting their court.
      const player = await seedPlayer(db, tenant.tenantId, 'sweep-pinned');
      await giveCredit(player, 1000);

      const id = await makeBooking({ bookedByUserId: player, hour: 3 });
      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: player,
        amountCents: 2400,
        bookingId: id,
      });

      let confirmNow: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        confirmNow = resolve;
      });

      const blocker = asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT id FROM booking WHERE id = $1 FOR UPDATE`, id);
        await held;
        await tx.booking.update({ where: { id }, data: { status: 'CONFIRMED' } });
      });

      const sweeping = sweep();
      // Long enough for the scan to run and the UPDATE to reach the lock.
      await new Promise((r) => setTimeout(r, 400));
      confirmNow();
      await blocker;

      const r = await sweeping;

      expect(r.released).toBe(0);
      expect(r.creditRefundedCents).toBe(0);
      expect(await statusOf(id)).toBe('CONFIRMED');
      expect(await creditOf(player)).toBe(0);

      const refunds = await asAppSuperuser(db, (tx) =>
        tx.creditLedgerEntry.findMany({
          where: { refType: 'booking', refId: id, reason: 'REFUND_CREDIT' },
        }),
      );
      expect(refunds).toHaveLength(0);
    });

    it('refunds nothing for a booking confirmed after the scan but before its write', async () => {
      // The other half of the race, and the one that reaches
      // `updated.count === 0` rather than a 40001.
      //
      // The scan and the per-booking writes are SEPARATE transactions, so a
      // booking can be confirmed in the gap. Its write then simply matches no
      // rows — no conflict, no error, nothing to notice.
      //
      // Reaching that deterministically takes two bookings: the sweep is
      // pinned on the first, and while it waits there, the second is confirmed
      // and committed. By the time the sweep opens a fresh transaction for the
      // second, its snapshot already says CONFIRMED.
      const first = await seedPlayer(db, tenant.tenantId, 'gap-first');
      const second = await seedPlayer(db, tenant.tenantId, 'gap-second');
      await giveCredit(first, 500);
      await giveCredit(second, 700);

      // `expiresAt asc` fixes the order, so `a` is the one the sweep pins on.
      const a = await makeBooking({
        bookedByUserId: first,
        hour: 5,
        expiresAt: new Date(Date.now() - 600_000),
      });
      const b = await makeBooking({
        bookedByUserId: second,
        hour: 6,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: first,
        amountCents: 500,
        bookingId: a,
      });
      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: second,
        amountCents: 700,
        bookingId: b,
      });

      let releaseLock: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      // Holds `a` only. No write, so when the sweep resumes it releases `a`
      // normally — this lock is a stopwatch, not a conflict.
      const blocker = asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT id FROM booking WHERE id = $1 FOR UPDATE`, a);
        await held;
      });

      const sweeping = sweep();
      await new Promise((r) => setTimeout(r, 400));

      // The sweep is parked on `a`. Confirm `b` and commit, so the sweep's
      // NEXT transaction opens with `b` already out of reach.
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({ where: { id: b }, data: { status: 'CONFIRMED' } }),
      );

      releaseLock();
      await blocker;
      const r = await sweeping;

      // `a` was genuinely abandoned: released, and its credit returned.
      expect(await statusOf(a)).toBe('CANCELLED');
      expect(await creditOf(first)).toBe(500);

      // `b` was paid for in the gap. It keeps its court and its spent credit.
      expect(await statusOf(b)).toBe('CONFIRMED');
      expect(await creditOf(second)).toBe(0);

      expect(r.released).toBe(1);
      expect(r.creditRefundedCents).toBe(500);

      const strayRefund = await asAppSuperuser(db, (tx) =>
        tx.creditLedgerEntry.findMany({
          where: { refType: 'booking', refId: b, reason: 'REFUND_CREDIT' },
        }),
      );
      expect(strayRefund).toHaveLength(0);
    });

    it('refunds once when two sweeps run at the same time', async () => {
      // This is the one that reaches `updated.count === 0`. A booking that was
      // ALREADY confirmed never enters the scan, so it cannot exercise that
      // branch — only a genuine interleave can: both sweeps scan and see the
      // same PENDING row, one wins the UPDATE, and the loser must return
      // without touching the ledger.
      //
      // Refunding before checking the count would credit this player twice
      // for one abandoned booking.
      const player = await seedPlayer(db, tenant.tenantId, 'sweep-concurrent');
      await giveCredit(player, 1000);

      const id = await makeBooking({ bookedByUserId: player, hour: 4 });
      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: player,
        amountCents: 2400,
        bookingId: id,
      });

      const [a, b] = await Promise.all([sweep(), sweep()]);

      expect(a.released + b.released).toBe(1);
      expect(a.creditRefundedCents + b.creditRefundedCents).toBe(1000);
      expect(await creditOf(player)).toBe(1000);

      const refunds = await asAppSuperuser(db, (tx) =>
        tx.creditLedgerEntry.findMany({
          where: { refType: 'booking', refId: id, reason: 'REFUND_CREDIT' },
        }),
      );
      expect(refunds).toHaveLength(1);
    });

    it('refunds nothing for a booking a payment confirmed first', async () => {
      // The sweep lost the race. Whoever moved the booking owns its money now
      // — refunding here would hand back credit for a court the player got.
      const player = await seedPlayer(db, tenant.tenantId, 'sweep-raced');
      await giveCredit(player, 1000);

      const id = await makeBooking({ bookedByUserId: player, hour: 2 });
      await spendCredit(db, {
        tenantId: tenant.tenantId,
        userId: player,
        amountCents: 2400,
        bookingId: id,
      });

      await asAppSuperuser(db, (tx) =>
        tx.booking.update({ where: { id }, data: { status: 'CONFIRMED' } }),
      );

      const r = await sweep();

      expect(r.released).toBe(0);
      expect(r.creditRefundedCents).toBe(0);
      expect(await creditOf(player)).toBe(0);
    });
  });
});
