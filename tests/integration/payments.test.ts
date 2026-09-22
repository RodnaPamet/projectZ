import type { PrismaClient } from '@prisma/client';

import {
  createSplit,
  findSplitByToken,
  refundBooking,
  checkoutBooking,
} from '@/app-layer/usecases/payments';
import {
  appendEntry,
  getBalance,
  spendCredit,
  InsufficientCreditError,
  LedgerIsolationError,
} from '@/app-layer/usecases/wallet';
import { PayoutsNotEnabledError } from '@/lib/billing/connect';
import { handleAccountUpdated, handleInvoicePaid } from '@/lib/billing/webhook-handlers';
import { pgErrorCode } from '@/lib/db/pg-errors';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { findRequest, useMswServer } from '../helpers/msw';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Payments 2.0, against a real database.
 *
 * ─── What these tests DO and DO NOT establish ────────────────────────
 *
 * Stripe is MSW-mocked at the HTTP layer. That means these tests DO prove:
 *
 *   • the exact body we send Stripe — that a destination charge really carries
 *     `application_fee_amount` and `transfer_data[destination]`, and that a
 *     refund really carries `reverse_transfer`;
 *   • every database-side guarantee: the append-only trigger, the share-sum
 *     invariant, the positive-share CHECK, RLS.
 *
 * They DO NOT prove that Stripe ACCEPTS those bodies. A wrong parameter name,
 * a capability we never requested, an account in the wrong country — none of
 * that can fail here, because our own mock is the thing answering.
 *
 * That gap closes when this runs against Stripe test mode with real keys. Until
 * then, treat "the Connect integration works" as UNVERIFIED. What is verified
 * is that our side of the conversation is correct and our money arithmetic is
 * exact.
 */

const HOUR = 3_600_000;

let db: PrismaClient;
let tenant: SeededTenant;

useMswServer();

beforeAll(() => {
  db = prismaTestClient();
});

beforeEach(async () => {
  tenant = await seedTenant();
});

/** A venue that has finished Connect onboarding. */
async function enablePayouts(tenantId: string, planTier: 'FREE' | 'CLUB' | 'PRO' = 'FREE') {
  return asAppSuperuser(db, (tx) =>
    tx.venueOrg.update({
      where: { id: tenantId },
      data: {
        stripeAccountId: `acct_test_${tenantId.slice(0, 8)}`,
        payoutsEnabled: true,
        planTier,
      },
    }),
  );
}

async function seedBooking(totalCents: number) {
  return asAppSuperuser(db, async (tx) => {
    const venue = await tx.venue.create({
      data: {
        tenantId: tenant.tenantId,
        name: 'Court Complex',
        slug: `venue-${Math.random().toString(36).slice(2, 10)}`,
        city: 'Sofia',
        addressLine: '1 Vitosha Blvd',
        lat: 42.6977,
        lng: 23.3219,
        email: 'v@playerz.test',
      },
    });

    const resource = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId: venue.id,
        name: 'Court 1',
        sport: 'TENNIS',
        resourceType: 'COURT',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });

    return tx.booking.create({
      data: {
        tenantId: tenant.tenantId,
        resourceId: resource.id,
        startTs: new Date(Date.now() + HOUR),
        endTs: new Date(Date.now() + 2 * HOUR),
        bookedByUserId: tenant.userId,
        totalCents,
        idempotencyKey: `idem-${Math.random().toString(36).slice(2, 12)}`,
      },
    });
  });
}

// ══ The ledger ═══════════════════════════════════════════════════════

/**
 * Full-jitter backoff for SERIALIZABLE retries. Shared by every test in this
 * file that contends, so the policy is stated once.
 *
 * Sleep uniformly in [0, window), not for `window`: the goal is to DECORRELATE
 * the retries. A fixed delay reschedules the same collision slightly later;
 * equal jitter keeps a common floor under it.
 */
const RETRY_BASE_MS = 5;
const RETRY_CAP_MS = 100;

describe('the credit ledger', () => {
  it('a balance is the sum of its entries, and starts at zero', async () => {
    expect(await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId })).toBe(0);

    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 1500,
      reason: 'ADMIN_ADJUST',
    });
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: -500,
      reason: 'SPEND',
    });

    expect(await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId })).toBe(1000);
  });

  it('REFUSES an UPDATE — the trigger, not the application, is what stops it', async () => {
    const entry = await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 500,
      reason: 'ADMIN_ADJUST',
    });

    // Deliberately bypassing the repository layer. Application code never does
    // this — that is what the `ledger-append-only` ratchet enforces. The point
    // here is that even if it DID, the database would refuse.
    //
    // As app_superuser, which has BYPASSRLS. There is no privilege level at
    // which rewriting the ledger is permitted.
    const attempt = asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE credit_ledger_entry SET "deltaCents" = 999999 WHERE id = $1`,
        entry.id,
      ),
    );

    // 23514 = check_violation, which is what the trigger raises.
    await expect(attempt).rejects.toThrow();
    await expect(attempt.catch((e) => pgErrorCode(e))).resolves.toBe('23514');

    // And the entry is untouched. (If the UPDATE had partially applied, the
    // balance would be wrong even though the statement "failed".)
    const after = await asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.findUniqueOrThrow({ where: { id: entry.id } }),
    );
    expect(after.deltaCents).toBe(500);
  });

  it('REFUSES a DELETE — an erased entry is worse than an altered one', async () => {
    const entry = await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 500,
      reason: 'ADMIN_ADJUST',
    });

    const attempt = asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM credit_ledger_entry WHERE id = $1`, entry.id),
    );

    await expect(attempt.catch((e) => pgErrorCode(e))).resolves.toBe('23514');

    const still = await asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.count({ where: { id: entry.id } }),
    );
    expect(still).toBe(1);
  });

  it('a correction is a COMPENSATING ENTRY, and the history survives it', async () => {
    // The whole point of append-only. We credited 5000 by mistake; it should
    // have been 500. We cannot edit that away — we say so, in the ledger.
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 5000,
      reason: 'ADMIN_ADJUST',
    });
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: -4500,
      reason: 'ADMIN_ADJUST',
    });

    expect(await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId })).toBe(500);

    // Both facts are still on the record: the mistake AND the correction.
    const entries = await db.creditLedgerEntry.findMany({
      where: { userId: tenant.userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((e) => e.deltaCents)).toEqual([5000, -4500]);
  });

  it('refuses to spend credit that is not there rather than going negative', async () => {
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 300,
      reason: 'ADMIN_ADJUST',
    });

    await expect(
      appendEntry(db, {
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        deltaCents: -1000,
        reason: 'SPEND',
      }),
    ).rejects.toThrow(InsufficientCreditError);

    // Unchanged — a rejected spend must not leave a partial entry.
    expect(await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId })).toBe(300);
  });

  it('CONCURRENT credits do not lose money (the write-skew that SERIALIZABLE prevents)', async () => {
    // Ten simultaneous credits of 100¢. Under READ COMMITTED they would all
    // read balance=0, all write balanceAfter=100, and the user would end up
    // with 100¢ instead of 1000¢ — while the deltas summed to 1000. The
    // balance and its own history would disagree.
    //
    // Under SERIALIZABLE, Postgres aborts the losers; we retry them.
    //
    // ─── The backoff is the point, not decoration ────────────────────
    //
    // This loop used to `continue` immediately. Ten aborted transactions
    // then retried at once, correlated, and collided again — and on a
    // slow enough machine one of them burned all 25 attempts and failed
    // the suite with "gave up retrying a serialization failure". It did
    // that on CI's instrumented coverage run while the uninstrumented
    // run of the SAME tests passed, which is the signature of contention
    // rather than a bug in the ledger.
    //
    // FULL jitter — sleep uniformly in [0, window) rather than for
    // `window` — because the goal is to DECORRELATE the retries. A fixed
    // delay reschedules the same collision slightly later; equal jitter
    // keeps a common floor under it. Only a uniform draw spreads the
    // retries across the window.
    //
    // No wall-clock deadline. It is tempting, but elapsed time here
    // includes the transaction work, not just the sleeping, so a 2s
    // budget would bind before the 25th attempt on precisely the slow
    // machine this exists to survive — fewer retries than the tight spin
    // it replaces. The attempt cap is the only limit, and the explicit
    // per-test timeout below is the backstop.
    const credit = async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          return await appendEntry(db, {
            tenantId: tenant.tenantId,
            userId: tenant.userId,
            deltaCents: 100,
            reason: 'ADMIN_ADJUST',
          });
        } catch (e) {
          // 40001 = serialization_failure. Retrying is the CORRECT response;
          // it is the mechanism working, not an error.
          //
          // Anything else — InsufficientCreditError above all — must
          // propagate on the FIRST throw. Retrying a refused spend would
          // turn one clean rejection into 25 identical ones.
          if (pgErrorCode(e) !== '40001') throw e;

          const window = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
          await new Promise((r) => setTimeout(r, Math.random() * window));
        }
      }
      throw new Error('gave up retrying a serialization failure');
    };

    await Promise.all(Array.from({ length: 10 }, credit));

    const balance = await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId });
    const entries = await db.creditLedgerEntry.findMany({ where: { userId: tenant.userId } });
    const sumOfDeltas = entries.reduce((a, e) => a + e.deltaCents, 0);

    expect(balance).toBe(1000);
    // The invariant that actually matters: the stored balance and the replayed
    // ledger agree. If these diverge, the denormalisation is lying.
    expect(sumOfDeltas).toBe(balance);
    expect(entries).toHaveLength(10);
    // 30s, against jest's 5000ms default. This test deliberately creates
    // contention and then waits it out; the default is a budget for a test
    // that does not, and it is what turns a slow machine into a red build.
  }, 30_000);

  /**
   * ═══ THE TEST ABOVE PROVES A GUARANTEE PRODUCTION CANNOT HAVE ═══
   *
   * It calls appendEntry on a TOP-LEVEL client, as a superuser that bypasses
   * FORCE RLS. Production can do neither: `credit_ledger_entry` has FORCE ROW
   * LEVEL SECURITY keyed on `app.tenant_id`, and the only thing that sets it
   * is `runInTenantContext` — which opens its own transaction first.
   *
   * appendEntry's `isolationLevel: Serializable` is then silently discarded.
   * Prisma sees an interactive transaction already open, treats the inner one
   * as nested, and issues SAVEPOINT instead of BEGIN; isolation is only ever
   * applied to a BEGIN.
   *
   * Measured before the guard existed: ten concurrent credits through this
   * path wrote ten rows whose deltas summed to 1000, while the balance those
   * same rows reported was 300. No error, no 40001, nothing to alert on.
   *
   * These two tests exist so that cannot be true again without the build
   * saying so.
   */
  it('REFUSES to write the ledger when SERIALIZABLE was silently downgraded', async () => {
    await expect(
      runInTenantContext(tenant.tenantId, (inner) =>
        appendEntry(inner, {
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          deltaCents: 100,
          reason: 'ADMIN_ADJUST',
        }),
      ),
    ).rejects.toThrow(LedgerIsolationError);

    // And it refused BEFORE writing anything. A guard that throws after the
    // insert would be a guard that still corrupted the ledger.
    expect(await db.creditLedgerEntry.count({ where: { userId: tenant.userId } })).toBe(0);
  });

  it('stays consistent when the isolation level is threaded to the outer transaction', async () => {
    // The same ten concurrent credits, through the wrapper production must
    // use, with the isolation level set where it can actually take effect.
    const credit = async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          return await runInTenantContext(
            tenant.tenantId,
            (inner) =>
              appendEntry(inner, {
                tenantId: tenant.tenantId,
                userId: tenant.userId,
                deltaCents: 100,
                reason: 'ADMIN_ADJUST',
              }),
            undefined,
            { isolationLevel: 'Serializable' },
          );
        } catch (e) {
          if (pgErrorCode(e) !== '40001') throw e;
          await new Promise((r) =>
            setTimeout(r, Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt)),
          );
        }
      }
      throw new Error('gave up retrying a serialization failure');
    };

    await Promise.all(Array.from({ length: 10 }, credit));

    const balance = await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId });
    const entries = await db.creditLedgerEntry.findMany({ where: { userId: tenant.userId } });

    expect(balance).toBe(1000);
    expect(entries.reduce((a, e) => a + e.deltaCents, 0)).toBe(balance);
    expect(entries).toHaveLength(10);
  }, 30_000);
});

// ══ Connect + checkout ═══════════════════════════════════════════════

describe('checkout via Stripe Connect', () => {
  it('sends a DESTINATION CHARGE carrying our application fee', async () => {
    await enablePayouts(tenant.tenantId, 'FREE'); // 5%
    const booking = await seedBooking(2400);

    const result = await checkoutBooking(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      bookingId: booking.id,
    });

    expect(result.cardDueCents).toBe(2400);
    expect(result.paymentIntentId).toMatch(/^pi_test_/);

    // Assert on what actually went over the wire. Stubbing the SDK would only
    // prove we called our own function.
    const req = findRequest('payment_intents');
    const body = req!.body as Record<string, string>;

    expect(Number(body.amount)).toBe(2400);
    expect(Number(body.application_fee_amount)).toBe(120); // 5% of 2400
    expect(body['transfer_data[destination]']).toBe(`acct_test_${tenant.tenantId.slice(0, 8)}`);
    // The venue is the merchant of record, not us.
    expect(body.on_behalf_of).toBe(`acct_test_${tenant.tenantId.slice(0, 8)}`);
  });

  it('charges a PRO venue less commission on the same booking', async () => {
    await enablePayouts(tenant.tenantId, 'PRO'); // 1.5%
    const booking = await seedBooking(2400);

    await checkoutBooking(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      bookingId: booking.id,
    });

    const body = findRequest('payment_intents')!.body as Record<string, string>;
    expect(Number(body.application_fee_amount)).toBe(36); // 1.5%, not 5%
  });

  it('REFUSES to take a card for a venue that cannot receive payouts', async () => {
    // No enablePayouts() — onboarding is incomplete.
    const booking = await seedBooking(2400);

    await expect(
      checkoutBooking(db, {
        tenantId: tenant.tenantId,
        userId: tenant.userId,
        bookingId: booking.id,
      }),
    ).rejects.toThrow(PayoutsNotEnabledError);

    // And crucially: we never asked Stripe for money. If we had, the customer
    // would see a card failure for the club's onboarding problem.
    expect(findRequest('payment_intents')).toBeUndefined();
  });

  it('spends the wallet first and only charges the card for the remainder', async () => {
    await enablePayouts(tenant.tenantId, 'FREE');
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 1000,
      reason: 'REFUND_CREDIT',
    });

    const booking = await seedBooking(2400);

    const result = await checkoutBooking(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      bookingId: booking.id,
      useWallet: true,
    });

    expect(result.walletAppliedCents).toBe(1000);
    expect(result.cardDueCents).toBe(1400);

    // The card is charged the REMAINDER, and the fee is on the remainder —
    // not on the full 2400. We do not take commission on our own credit.
    const body = findRequest('payment_intents')!.body as Record<string, string>;
    expect(Number(body.amount)).toBe(1400);
    expect(Number(body.application_fee_amount)).toBe(70); // 5% of 1400

    expect(await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId })).toBe(0);
  });

  it('does not create a zero-amount PaymentIntent when credit covers the lot', async () => {
    await enablePayouts(tenant.tenantId);
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 5000,
      reason: 'REFUND_CREDIT',
    });

    const booking = await seedBooking(2400);

    const result = await checkoutBooking(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      bookingId: booking.id,
      useWallet: true,
    });

    expect(result.cardDueCents).toBe(0);
    expect(result.paymentIntentId).toBeNull();

    // Stripe REJECTS a zero-amount intent. Creating one would turn a
    // fully-covered booking into a payment error.
    expect(findRequest('payment_intents')).toBeUndefined();

    expect(await getBalance(db, { tenantId: tenant.tenantId, userId: tenant.userId })).toBe(2600);
  });

  it('spending the wallet twice for one booking is impossible — the credit is gone', async () => {
    await appendEntry(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deltaCents: 1000,
      reason: 'REFUND_CREDIT',
    });

    const first = await spendCredit(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      amountCents: 1000,
      bookingId: 'bk_1',
    });
    expect(first.walletAppliedCents).toBe(1000);

    // The second attempt finds an empty wallet and applies nothing, rather than
    // spending credit that is no longer there.
    const second = await spendCredit(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      amountCents: 1000,
      bookingId: 'bk_1',
    });
    expect(second.walletAppliedCents).toBe(0);
    expect(second.cardDueCents).toBe(1000);
  });
});

// ══ Refunds ══════════════════════════════════════════════════════════

describe('refunds reverse the venue transfer and our fee', () => {
  async function paidBooking(totalCents: number, tier: 'FREE' | 'CLUB' | 'PRO' = 'FREE') {
    await enablePayouts(tenant.tenantId, tier);
    const booking = await seedBooking(totalCents);
    await checkoutBooking(db, {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      bookingId: booking.id,
    });
    return booking;
  }

  it('a FULL refund reverses the transfer and gives back the whole fee', async () => {
    const booking = await paidBooking(2400);

    const result = await refundBooking(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      refundCents: 2400,
    });

    expect(result.feeReversedCents).toBe(120);
    expect(result.transferReversedCents).toBe(2280);

    const body = findRequest('refunds')!.body as Record<string, string>;
    expect(Number(body.amount)).toBe(2400);
    // Without reverse_transfer, we would refund the customer out of OUR balance
    // while the venue kept its payout — we would be funding the club's
    // cancellations, and would notice when our Stripe balance went negative.
    expect(body.reverse_transfer).toBe('true');
    expect(body.refund_application_fee).toBe('true');

    const after = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CANCELLED');
  });

  it('a PARTIAL refund reverses proportionally and does NOT cancel the booking', async () => {
    const booking = await paidBooking(2400);

    const result = await refundBooking(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      refundCents: 1200,
    });

    expect(result.feeReversedCents).toBe(60); // half our fee
    expect(result.transferReversedCents).toBe(1140);
    expect(result.feeReversedCents + result.transferReversedCents).toBe(1200);

    // A partial refund is a partial refund. The booking still stands — the
    // player is still coming, they just got some money back.
    const after = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).not.toBe('CANCELLED');
  });

  it('two partial refunds summing to the total DO cancel it, and are two separate records', async () => {
    const booking = await paidBooking(2400);

    await refundBooking(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      refundCents: 1000,
    });
    await refundBooking(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      refundCents: 1400,
    });

    const refunds = await db.refund.findMany({ where: { bookingId: booking.id } });

    // Two facts, not one running total. "What was refunded, and when?" has an
    // answer.
    expect(refunds).toHaveLength(2);
    expect(refunds.reduce((a, r) => a + r.amountCents, 0)).toBe(2400);

    const after = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CANCELLED');
  });
});

// ══ Splits ═══════════════════════════════════════════════════════════

describe('cost splitting', () => {
  it('splits three ways with the shares summing EXACTLY to the total', async () => {
    const booking = await seedBooking(5000); // does not divide by 3

    const splits = await createSplit(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      participants: [
        { userId: tenant.userId },
        { inviteEmail: 'friend@playerz.test' },
        { inviteEmail: 'other@playerz.test' },
      ],
    });

    expect(splits.map((s) => s.shareCents)).toEqual([1667, 1667, 1666]);
    expect(splits.reduce((a, s) => a + s.shareCents, 0)).toBe(5000);

    const rows = await db.bookingSplit.findMany({ where: { bookingId: booking.id } });
    expect(rows.reduce((a, r) => a + r.shareCents, 0)).toBe(booking.totalCents);
  });

  it('stores only the token HASH — a leaked database is not a set of payment links', async () => {
    const booking = await seedBooking(2400);

    const [split] = await createSplit(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      participants: [{ userId: tenant.userId }, { inviteEmail: 'friend@playerz.test' }],
    });

    const row = await db.bookingSplit.findUniqueOrThrow({ where: { id: split!.splitId } });

    expect(row.tokenHash).not.toBe(split!.token);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    // The raw token appears NOWHERE in the row.
    expect(JSON.stringify(row)).not.toContain(split!.token);

    // …and it still resolves when presented.
    const found = await findSplitByToken(db, split!.token);
    expect(found?.id).toBe(split!.splitId);
  });

  it('an EXPIRED link is not payable', async () => {
    const booking = await seedBooking(2400);
    const [split] = await createSplit(db, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      participants: [{ userId: tenant.userId }, { inviteEmail: 'f@playerz.test' }],
    });

    await asAppSuperuser(db, (tx) =>
      tx.bookingSplit.update({
        where: { id: split!.splitId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );

    expect(await findSplitByToken(db, split!.token)).toBeNull();
  });

  it('a garbage token resolves to nothing', async () => {
    expect(await findSplitByToken(db, 'not-a-real-token')).toBeNull();
  });

  it('the database REFUSES a zero or negative share', async () => {
    const booking = await seedBooking(2400);

    // Bypassing createSplit's validation on purpose: the CHECK constraint is
    // the last line of defence, and it must hold on its own.
    const attempt = asAppSuperuser(db, (tx) =>
      tx.bookingSplit.create({
        data: {
          tenantId: tenant.tenantId,
          bookingId: booking.id,
          shareCents: 0,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + HOUR),
        },
      }),
    );

    await expect(attempt.catch((e) => pgErrorCode(e))).resolves.toBe('23514');
  });

  it('rejects a custom split that does not sum to the total', async () => {
    const booking = await seedBooking(2400);

    await expect(
      createSplit(db, {
        tenantId: tenant.tenantId,
        bookingId: booking.id,
        participants: [{ userId: tenant.userId }, { inviteEmail: 'f@playerz.test' }],
        customShares: [1200, 1199], // a cent short
      }),
    ).rejects.toThrow(/2399.*2400/s);

    // Nothing was written. A partially-created split is worse than none.
    expect(await db.bookingSplit.count({ where: { bookingId: booking.id } })).toBe(0);
  });
});

// ══ Webhooks ═════════════════════════════════════════════════════════

describe('Stripe webhooks', () => {
  it('account.updated is what flips payoutsEnabled — and can flip it BACK', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: tenant.tenantId },
        data: { stripeAccountId: 'acct_hook_test' },
      }),
    );

    await handleAccountUpdated(db, {
      id: 'acct_hook_test',
      payouts_enabled: true,
    } as never);

    let venue = await db.venueOrg.findUniqueOrThrow({ where: { id: tenant.tenantId } });
    expect(venue.payoutsEnabled).toBe(true);

    // Stripe DISABLES payouts later — a failed identity check, an expired
    // document. If we latched the flag to true, we would keep taking bookings
    // for a club we can no longer pay.
    await handleAccountUpdated(db, {
      id: 'acct_hook_test',
      payouts_enabled: false,
    } as never);

    venue = await db.venueOrg.findUniqueOrThrow({ where: { id: tenant.tenantId } });
    expect(venue.payoutsEnabled).toBe(false);
  });

  it('invoice.paid activates the membership it belongs to', async () => {
    const membership = await asAppSuperuser(db, (tx) =>
      tx.membership.create({
        data: {
          tenantId: tenant.tenantId,
          playerUserId: tenant.userId,
          level: 'GOLD',
          priceCents: 5000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 30 * 24 * HOUR),
          status: 'INVITED',
          stripeSubscriptionId: 'sub_hook_test',
        },
      }),
    );

    const r = await handleInvoicePaid(db, {
      id: 'in_test',
      parent: { subscription_details: { subscription: 'sub_hook_test' } },
    } as never);

    expect(r.handled).toBe(true);

    const after = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('ACTIVE');
  });

  it('a redelivered invoice.paid is a no-op, not a second activation', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.membership.create({
        data: {
          tenantId: tenant.tenantId,
          playerUserId: tenant.userId,
          level: 'GOLD',
          priceCents: 5000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 30 * 24 * HOUR),
          stripeSubscriptionId: 'sub_replay',
        },
      }),
    );

    // Stripe delivers at-least-once. A handler that INCREMENTED anything here
    // would double it on the retry.
    const event = {
      id: 'in_replay',
      parent: { subscription_details: { subscription: 'sub_replay' } },
    } as never;

    await handleInvoicePaid(db, event);
    await handleInvoicePaid(db, event);

    const memberships = await db.membership.findMany({
      where: { stripeSubscriptionId: 'sub_replay' },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.status).toBe('ACTIVE');
  });

  it('an invoice with no subscription is reported unhandled, not silently swallowed', async () => {
    const r = await handleInvoicePaid(db, { id: 'in_oneoff', parent: null } as never);
    expect(r.handled).toBe(false);
  });
});
