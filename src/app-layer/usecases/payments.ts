import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  PayoutsNotEnabledError,
  createDestinationCharge,
  retrievePaymentIntent,
  refundWithFeeReversal,
} from '@/lib/billing/connect';
import { refundSplit } from '@/lib/billing/platform-fee';

import { assertSharesSumToTotal, partitionEqually } from './booking-split';
import { spendCredit } from './wallet';

/**
 * Checkout, refunds, and split links.
 *
 * The order of operations in `checkoutBooking` is the whole point of the file.
 */

export class VenueNotPayableError extends Error {
  readonly code = 'venue_not_payable';
  constructor(message: string) {
    super(message);
    this.name = 'VenueNotPayableError';
  }
}

/** A split link expires; an unpaid share does not hang over a booking forever. */
export const SPLIT_LINK_TTL_HOURS = 48;

/**
 * Pay for a booking: wallet first, card for the remainder.
 *
 * ─── Why the payouts check comes FIRST ───────────────────────────────
 *
 * Stripe rejects a destination charge to an account that cannot receive
 * payouts. If we discover that during `paymentIntents.create`, the customer has
 * already entered their card and sees a payment failure — for a problem that is
 * entirely the club's incomplete onboarding. Check before we ask for a card.
 *
 * ─── Why the wallet is spent BEFORE the card is charged ──────────────
 *
 * If the card were charged first and the wallet debit then failed, the customer
 * has paid full price with credit still sitting in their account. Spending the
 * credit first means the worst case is the opposite: credit is debited and the
 * card charge fails, and we refund the credit — a compensating LEDGER ENTRY,
 * which is exactly the operation an append-only ledger is built for.
 *
 * Neither ordering is atomic across two systems. This one fails in the
 * direction we can actually repair.
 */
export async function checkoutBooking(
  db: PrismaClient,
  input: {
    tenantId: string;
    userId: string;
    bookingId: string;
    useWallet?: boolean;
  },
): Promise<{
  walletAppliedCents: number;
  cardDueCents: number;
  paymentIntentId: string | null;
  clientSecret: string | null;
}> {
  const booking = await db.booking.findFirstOrThrow({
    where: { id: input.bookingId, tenantId: input.tenantId },
  });

  const venue = await db.venueOrg.findUniqueOrThrow({ where: { id: input.tenantId } });

  if (!venue.stripeAccountId || !venue.payoutsEnabled) {
    throw new PayoutsNotEnabledError(venue.name);
  }

  // ═══ A CHECKOUT ALREADY IN FLIGHT IS RESUMED, NOT RESTARTED ═══
  //
  // Without this, a second tap on Pay was not idempotent in any of the three
  // ways that matter, and the combination lost money outright:
  //
  //   - `spendCredit` ran AGAIN, draining more of the wallet;
  //   - `cardDueCents` therefore differed, so the idempotency key differed —
  //     the key included the amount, which is the one thing that changes
  //     between attempts — and Stripe minted a SECOND PaymentIntent;
  //   - `stripePaymentIntentId` was overwritten to point at it.
  //
  // The player then paid the sheet they were first shown. The webhook looks a
  // booking up BY that column, found nothing for the intent that was actually
  // charged, and returned `no-payment-intent-link` before writing a Payment
  // row or an audit entry. Card captured, booking left PENDING, swept fifteen
  // minutes later — and the money existed nowhere in our database.
  //
  // So the intent is the lock. Once one exists for a booking, that IS the
  // checkout: the split is fixed until it is paid or the booking is cancelled.
  // A caller changing `useWallet` on a retry gets the original split back
  // rather than a second charge, which is the safe direction.
  if (booking.stripePaymentIntentId) {
    const existing = await retrievePaymentIntent(booking.stripePaymentIntentId);

    // Whatever the wallet already covered, read back from the ledger rather
    // than recomputed — `spendCredit` must not run twice.
    const spent = await db.creditLedgerEntry.aggregate({
      where: {
        tenantId: input.tenantId,
        refType: 'booking',
        refId: booking.id,
        reason: 'SPEND',
      },
      _sum: { deltaCents: true },
    });

    return {
      walletAppliedCents: Math.abs(spent._sum?.deltaCents ?? 0),
      cardDueCents: existing.amount,
      paymentIntentId: existing.id,
      clientSecret: existing.client_secret ?? null,
    };
  }

  // ── 1. Wallet ──────────────────────────────────────────────────────
  const { walletAppliedCents, cardDueCents } = input.useWallet
    ? await spendCredit(db, {
        tenantId: input.tenantId,
        userId: input.userId,
        amountCents: booking.totalCents,
        bookingId: booking.id,
      })
    : { walletAppliedCents: 0, cardDueCents: booking.totalCents };

  // Credit covered the lot. Do not create a zero-amount PaymentIntent —
  // Stripe rejects it, and there is nothing to charge.
  if (cardDueCents === 0) {
    return { walletAppliedCents, cardDueCents: 0, paymentIntentId: null, clientSecret: null };
  }

  // ── 2. Card ────────────────────────────────────────────────────────
  //
  // The key names the BOOKING, and nothing that can change between attempts.
  //
  // It used to include `cardDueCents`, described as "what makes this charge
  // unique". That is exactly backwards: the amount is the one input a retry
  // alters, because the wallet has been drained in between. Two taps produced
  // two keys and two PaymentIntents — the opposite of what the key is for.
  //
  // Belt and braces with the resume path above: that stops a second intent
  // being requested at all, and this stops Stripe minting one if it is.
  const intent = await createDestinationCharge({
    totalCents: cardDueCents,
    currency: venue.currency,
    tier: venue.planTier,
    stripeAccountId: venue.stripeAccountId,
    bookingId: booking.id,
    idempotencyKey: `booking:${booking.id}:checkout`,
  });

  await db.booking.update({
    where: { id: booking.id },
    data: { stripePaymentIntentId: intent.id },
  });

  return {
    walletAppliedCents,
    cardDueCents,
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret ?? null,
  };
}

/**
 * Refund a booking, giving back our commission in proportion.
 *
 * The customer's refund may be partial (a late cancellation forfeits some of
 * it). Whatever the amount, the venue's transfer and our fee are both reversed
 * pro rata — see `refundSplit`.
 */
export async function refundBooking(
  db: PrismaClient,
  input: { tenantId: string; bookingId: string; refundCents: number },
): Promise<{ feeReversedCents: number; transferReversedCents: number; refundId: string }> {
  const booking = await db.booking.findFirstOrThrow({
    where: { id: input.bookingId, tenantId: input.tenantId },
  });

  if (!booking.stripePaymentIntentId) {
    throw new Error(`Booking ${booking.id} has no payment to refund.`);
  }

  const venue = await db.venueOrg.findUniqueOrThrow({ where: { id: input.tenantId } });

  const { feeReversedCents, transferReversedCents } = refundSplit(
    booking.totalCents,
    input.refundCents,
    venue.planTier,
  );

  const refund = await refundWithFeeReversal({
    paymentIntentId: booking.stripePaymentIntentId,
    refundCents: input.refundCents,
    feeReversedCents,
    // Refunding twice would return the money twice. The amount is IN the key:
    // a second refund of a different amount is a legitimately different
    // operation, a repeat of the same one is not.
    idempotencyKey: `refund:${booking.id}:${input.refundCents}`,
  });

  // Record the refund as its OWN row rather than mutating a running total on
  // the booking. Two partial refunds are two facts, each with its own amount,
  // reason and Stripe id — collapsing them into one number on the booking
  // destroys the ability to answer "what was refunded, and why?".
  await db.refund.create({
    data: {
      tenantId: input.tenantId,
      bookingId: booking.id,
      amountCents: input.refundCents,
      currency: venue.currency,
      providerRefId: refund.id,
      status: 'PAID',
      processedAt: new Date(),
    },
  });

  // Only a FULL refund cancels the booking. A partial one (a late-cancellation
  // fee withheld, say) leaves the booking exactly as it was.
  const refundedSoFar = await db.refund.aggregate({
    where: { tenantId: input.tenantId, bookingId: booking.id, status: 'PAID' },
    _sum: { amountCents: true },
  });

  if ((refundedSoFar._sum.amountCents ?? 0) >= booking.totalCents) {
    await db.booking.update({
      where: { id: booking.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  return { feeReversedCents, transferReversedCents, refundId: refund.id };
}

/**
 * Split a booking N ways and mint one payment link per person.
 *
 * NOT WIRED. No route creates or redeems a split, nothing sends the token,
 * and `SPLIT_REIMBURSEMENT` is never written outside tests. The only callers
 * of this function and of `findSplitByToken` are in
 * tests/integration/payments.test.ts.
 *
 * This comment used to say the raw token is "returned ONCE, to be emailed",
 * which describes a flow that does not exist — `resend` is installed and no
 * sender was ever written. Said plainly here because the alternative is the
 * next reader tracing imports by hand to find out, which is exactly what an
 * audit had to do.
 *
 * The mechanism itself is correct and tested, and the hashing is the part
 * worth keeping right: only the hash is stored, so a leaked database backup
 * must not hand an attacker every open payment link in the system. Same
 * reasoning as a password — we never need the original back, only to
 * recognise it when it is presented.
 */
export async function createSplit(
  db: PrismaClient,
  input: {
    tenantId: string;
    bookingId: string;
    /** The booker plus everyone they are splitting with. */
    participants: Array<{ userId?: string; inviteEmail?: string }>;
    /** Omit for an equal split. Must sum to the booking total if given. */
    customShares?: number[];
  },
): Promise<Array<{ splitId: string; token: string; shareCents: number }>> {
  const booking = await db.booking.findFirstOrThrow({
    where: { id: input.bookingId, tenantId: input.tenantId },
  });

  const shares =
    input.customShares ?? partitionEqually(booking.totalCents, input.participants.length);

  if (shares.length !== input.participants.length) {
    throw new Error(`${shares.length} shares for ${input.participants.length} participants.`);
  }

  // Belt and braces: `partitionEqually` sums correctly by construction, but a
  // caller-supplied `customShares` has had no such guarantee applied to it.
  assertSharesSumToTotal(shares, booking.totalCents);

  const expiresAt = new Date(Date.now() + SPLIT_LINK_TTL_HOURS * 3600 * 1000);

  const created = await Promise.all(
    input.participants.map(async (p, i) => {
      // 32 bytes from a CSPRNG. A guessable token is a stranger paying — or
      // more to the point, a stranger READING someone's booking.
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');

      const split = await db.bookingSplit.create({
        data: {
          tenantId: input.tenantId,
          bookingId: booking.id,
          userId: p.userId ?? null,
          inviteEmail: p.inviteEmail ?? null,
          shareCents: shares[i]!,
          tokenHash,
          expiresAt,
        },
      });

      return { splitId: split.id, token, shareCents: split.shareCents };
    }),
  );

  return created;
}

/**
 * Look a split up by the token the user presented. Constant-time by hashing.
 *
 * NOT WIRED — see `createSplit`. There is no POST for this to get past yet.
 */
export async function findSplitByToken(db: PrismaClient, token: string) {
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const split = await db.bookingSplit.findUnique({ where: { tokenHash } });
  if (!split) return null;

  // An expired link is not a payable link. Checked here rather than in a UI,
  // because a check in a UI is not a check — whenever the route that redeems
  // this is written, it will arrive through this function.
  if (split.expiresAt.getTime() < Date.now()) return null;

  return split;
}
