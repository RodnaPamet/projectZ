import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * Turning a successful payment into a confirmed booking.
 *
 * ═══ WHAT WAS HERE BEFORE ═══
 *
 * Nothing. `payment_intent.succeeded` returned `{ received: true }` and
 * touched no table, while the route's doc comment described an `updateMany`
 * on a PENDING row that did not exist in the file. Nothing anywhere in the
 * application wrote a booking to CONFIRMED, and nothing ever created a
 * `Payment` row — that table had no writer at all.
 *
 * So a booking was created PENDING and stayed PENDING for ever: it could not
 * be paid for, and payment could not have confirmed it if it had been.
 *
 * ═══ THE BOOKING IS FOUND BY OUR OWN COLUMN, NOT BY METADATA ═══
 *
 * `checkoutBooking` writes `booking.stripePaymentIntentId` when it creates the
 * intent, and `createDestinationCharge` also stamps `metadata.bookingId`.
 * Either could identify the booking; this uses the column.
 *
 * The difference matters. Metadata is a string we handed Stripe and get back
 * unverified — an attacker who could induce a PaymentIntent with chosen
 * metadata would be choosing which booking gets confirmed. The column was
 * written by us, from our own transaction, against a row we already owned.
 * The metadata is cross-checked and a mismatch refuses, which should never
 * fire and would mean something is badly wrong if it did.
 *
 * ═══ AMOUNT IS VERIFIED, NOT ASSUMED ═══
 *
 * The intent's `amount_received` is compared against what the booking says it
 * costs. A booking confirmed for less than its price is a free court, and the
 * only place that could be caught is here — nothing downstream re-checks.
 * Wallet credit legitimately reduces the card amount, so the comparison
 * allows for it rather than demanding equality.
 */

export interface ConfirmResult {
  handled: boolean;
  bookingId?: string;
  reason?:
    'no-payment-intent-link' | 'metadata-mismatch' | 'amount-short' | 'not-pending' | 'confirmed';
}

export async function handlePaymentIntentSucceeded(
  db: PrismaClient,
  intent: Stripe.PaymentIntent,
): Promise<ConfirmResult> {
  const booking = await db.booking.findFirst({
    where: { stripePaymentIntentId: intent.id },
    select: {
      id: true,
      tenantId: true,
      status: true,
      totalCents: true,
      currency: true,
      bookedByUserId: true,
    },
  });

  // Not ours, or a payment for something that is not a booking. Acknowledged
  // rather than retried — Stripe cannot fix this by sending it again.
  if (!booking) return { handled: false, reason: 'no-payment-intent-link' };

  const claimed = typeof intent.metadata?.bookingId === 'string' ? intent.metadata.bookingId : null;
  if (claimed && claimed !== booking.id) {
    // Should be impossible: both sides were written by us. If it ever fires,
    // something is badly wrong and a silent 200 would bury it.
    await appendAuditEntry(db, {
      tenantId: booking.tenantId,
      actorUserId: null,
      actorType: 'SYSTEM',
      entity: 'Booking',
      entityId: booking.id,
      action: AUDIT_ACTIONS.PAYMENT_UNAPPLIED,
      details: `Payment ${intent.id} metadata names booking ${claimed}, but the intent is linked to ${booking.id}`,
      detailsJson: {
        category: 'payment',
        summary: 'PaymentIntent metadata disagrees with our own link — not confirmed',
        paymentIntentId: intent.id,
        metadataBookingId: claimed,
        linkedBookingId: booking.id,
        reason: 'metadata-mismatch',
      },
    });

    return { handled: false, bookingId: booking.id, reason: 'metadata-mismatch' };
  }

  const received = intent.amount_received ?? 0;

  // ═══ THE MONEY IS RECORDED BEFORE ANY DECISION ABOUT THE BOOKING ═══
  //
  // An earlier draft returned early on every refusal — a cancelled booking, a
  // short payment — and wrote nothing. Stripe had already CAPTURED the card by
  // the time this event fires, so those paths left real money in the club's
  // balance with no Payment row, no audit entry and no alert. And because the
  // event claim commits with the refusal, Stripe never retries and a
  // deliberate dashboard replay is discarded as a duplicate. The charge became
  // undiscoverable except by reading Stripe.
  //
  // `payment_intent.succeeded` means the money moved. Whether we then confirm
  // the booking is a separate question, and it must not decide whether we
  // write down that it moved.
  await db.payment.createMany({
    data: [
      {
        tenantId: booking.tenantId,
        bookingId: booking.id,
        provider: 'STRIPE',
        providerRefId: intent.id,
        amountCents: received,
        currency: booking.currency,
        status: 'PAID',
        paidAt: new Date(),
      },
    ],
    // Keyed on the intent, so a second event for the same charge cannot
    // create a second row.
    skipDuplicates: true,
  });

  // Wallet credit is applied before the card, so the charge is legitimately
  // smaller than the booking total. What must never happen is the card
  // covering LESS than the part the wallet did not.
  // `spendCredit` records the spend as a NEGATIVE deltaCents with
  // refType 'booking' — there is no bookingId column on the ledger, so the
  // polymorphic ref is the link. Summing and taking the absolute value gives
  // what the wallet covered.
  const walletApplied = await db.creditLedgerEntry.aggregate({
    where: {
      tenantId: booking.tenantId,
      refType: 'booking',
      refId: booking.id,
      reason: 'SPEND',
    },
    _sum: { deltaCents: true },
  });

  const creditUsed = Math.abs(walletApplied._sum?.deltaCents ?? 0);

  if (received + creditUsed < booking.totalCents) {
    // Deliberately NOT confirmed — guessing which of the two numbers is wrong
    // is not this function's job. But the money is real, so it is recorded
    // above and flagged here. Somebody has to reconcile this by hand, and they
    // cannot do that if nothing says it happened.
    await appendAuditEntry(db, {
      tenantId: booking.tenantId,
      actorUserId: null,
      actorType: 'SYSTEM',
      entity: 'Booking',
      entityId: booking.id,
      action: AUDIT_ACTIONS.PAYMENT_UNAPPLIED,
      details: `Payment ${intent.id} of ${received} does not cover ${booking.totalCents}; booking NOT confirmed`,
      detailsJson: {
        category: 'payment',
        summary: 'Payment received but insufficient — needs manual reconciliation',
        paymentIntentId: intent.id,
        amountReceivedCents: received,
        walletAppliedCents: creditUsed,
        bookingTotalCents: booking.totalCents,
        reason: 'amount-short',
      },
    });

    return { handled: false, bookingId: booking.id, reason: 'amount-short' };
  }

  // `updateMany` filtered on PENDING, not `update`. A second delivery — or a
  // race with a cancellation — then changes zero rows instead of resurrecting
  // a booking the player has already cancelled.
  const updated = await db.booking.updateMany({
    where: { id: booking.id, status: 'PENDING' },
    data: { status: 'CONFIRMED', expiresAt: null },
  });

  if (updated.count === 0) {
    // The booking was cancelled (or already confirmed) between checkout and
    // this event — a player cancelling mid-3DS is an ordinary race, not an
    // exotic one, and nothing voids the intent when they do.
    //
    // The charge stands and is recorded above. This entry is what makes it
    // findable: without it the club holds money for a court nobody booked and
    // the only trace is in Stripe.
    await appendAuditEntry(db, {
      tenantId: booking.tenantId,
      actorUserId: null,
      actorType: 'SYSTEM',
      entity: 'Booking',
      entityId: booking.id,
      action: AUDIT_ACTIONS.PAYMENT_UNAPPLIED,
      details: `Payment ${intent.id} arrived for a booking that is no longer PENDING; refund likely required`,
      detailsJson: {
        category: 'payment',
        summary: 'Payment received for a booking that could not be confirmed',
        paymentIntentId: intent.id,
        amountReceivedCents: received,
        bookingStatus: booking.status,
        reason: 'not-pending',
      },
    });

    return { handled: false, bookingId: booking.id, reason: 'not-pending' };
  }

  await appendAuditEntry(db, {
    tenantId: booking.tenantId,
    actorUserId: null,
    // Stripe told us this happened. No human at this club decided it.
    actorType: 'SYSTEM',
    entity: 'Booking',
    entityId: booking.id,
    action: AUDIT_ACTIONS.BOOKING_CONFIRMED,
    details: `Payment ${intent.id} confirmed booking for ${received} ${booking.currency}`,
    detailsJson: {
      category: 'payment',
      summary: 'Booking confirmed by Stripe payment',
      before: { status: 'PENDING' },
      after: { status: 'CONFIRMED' },
      paymentIntentId: intent.id,
      amountReceivedCents: received,
      walletAppliedCents: creditUsed,
    },
  });

  return { handled: true, bookingId: booking.id, reason: 'confirmed' };
}
