import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import type { LocalisedNotifyInput } from '@/app-layer/usecases/notifications';
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
  /**
   * Set only on `confirmed`, and only when there is somebody to tell.
   *
   * A DESCRIPTION of the notification, not a written row: `notification` is
   * owner-only on `app.user_id` and this function runs under whatever binding
   * its caller holds — a tenant one, for checkout. The caller passes this to
   * `notifyAfterCommit` once its transaction commits.
   */
  notify?: LocalisedNotifyInput;
  reason?:
    'no-payment-intent-link' | 'metadata-mismatch' | 'amount-short' | 'not-pending' | 'confirmed';
}

export interface ConfirmInput {
  booking: {
    id: string;
    tenantId: string;
    status: string;
    totalCents: number;
    currency: string;
    /** Null for a guest booking: nobody to notify, and no device to notify. */
    bookedByUserId: string | null;
  };
  provider: string;
  /** Unique per charge. `(provider, providerRefId)` is a UNIQUE index. */
  providerRefId: string;
  receivedCents: number;
  creditUsedCents: number;
}

/**
 * Record the money, then decide about the booking. Shared by the webhook and
 * by the checkout route.
 *
 * ═══ WHY SHARED RATHER THAN WRITTEN TWICE ═══
 *
 * A booking can be paid two ways: a card, confirmed later by a Stripe webhook,
 * or entirely from wallet credit, which produces no PaymentIntent and
 * therefore no webhook at all. Those are different triggers for identical
 * bookkeeping — record the payment, flip PENDING to CONFIRMED, audit it.
 *
 * Two copies of that would drift, and the drift would be silent: a change to
 * the card path fixing something the wallet path still gets wrong, discovered
 * by a player whose credit-paid booking quietly expired.
 */
export async function recordPaymentAndConfirm(
  db: PrismaClient,
  input: ConfirmInput,
): Promise<ConfirmResult> {
  const { booking, receivedCents, creditUsedCents } = input;

  // ═══ THE MONEY IS RECORDED BEFORE ANY DECISION ABOUT THE BOOKING ═══
  //
  // An earlier draft returned early on every refusal and wrote nothing. Stripe
  // has already CAPTURED the card by the time its event fires, so those paths
  // left real money in the club's balance with no Payment row, no audit entry
  // and no alert — and because the webhook's event claim commits with the
  // refusal, Stripe never retries and a dashboard replay is discarded as a
  // duplicate. The charge became undiscoverable except by reading Stripe.
  //
  // Payment succeeding means the money moved. Whether we then confirm the
  // booking is a separate question, and it must not decide whether we write
  // down that it moved.
  await db.payment.createMany({
    data: [
      {
        tenantId: booking.tenantId,
        bookingId: booking.id,
        provider: input.provider,
        providerRefId: input.providerRefId,
        amountCents: receivedCents,
        currency: booking.currency,
        status: 'PAID',
        paidAt: new Date(),
      },
    ],
    // Real, since P28 added UNIQUE(provider, providerRefId). Before that this
    // silently inserted a second PAID row for a redelivered event.
    skipDuplicates: true,
  });

  if (receivedCents + creditUsedCents < booking.totalCents) {
    await appendAuditEntry(db, {
      tenantId: booking.tenantId,
      actorUserId: null,
      actorType: 'SYSTEM',
      entity: 'Booking',
      entityId: booking.id,
      action: AUDIT_ACTIONS.PAYMENT_UNAPPLIED,
      details: `Payment ${input.providerRefId} of ${receivedCents} does not cover ${booking.totalCents}; booking NOT confirmed`,
      detailsJson: {
        category: 'payment',
        summary: 'Payment received but insufficient — needs manual reconciliation',
        providerRefId: input.providerRefId,
        amountReceivedCents: receivedCents,
        walletAppliedCents: creditUsedCents,
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
    // Cancelled (or already confirmed) between checkout and payment — a player
    // cancelling mid-3DS is an ordinary race, and nothing voids the intent.
    // The charge stands and is recorded above; this entry is what makes it
    // findable.
    await appendAuditEntry(db, {
      tenantId: booking.tenantId,
      actorUserId: null,
      actorType: 'SYSTEM',
      entity: 'Booking',
      entityId: booking.id,
      action: AUDIT_ACTIONS.PAYMENT_UNAPPLIED,
      details: `Payment ${input.providerRefId} arrived for a booking that is no longer PENDING; refund likely required`,
      detailsJson: {
        category: 'payment',
        summary: 'Payment received for a booking that could not be confirmed',
        providerRefId: input.providerRefId,
        amountReceivedCents: receivedCents,
        bookingStatus: booking.status,
        reason: 'not-pending',
      },
    });

    return { handled: false, bookingId: booking.id, reason: 'not-pending' };
  }

  await appendAuditEntry(db, {
    tenantId: booking.tenantId,
    actorUserId: null,
    // Nobody at the club decided this. The payment did.
    actorType: 'SYSTEM',
    entity: 'Booking',
    entityId: booking.id,
    action: AUDIT_ACTIONS.BOOKING_CONFIRMED,
    details: `Payment ${input.providerRefId} confirmed booking for ${receivedCents} ${booking.currency}`,
    detailsJson: {
      category: 'payment',
      summary: 'Booking confirmed by payment',
      before: { status: 'PENDING' },
      after: { status: 'CONFIRMED' },
      provider: input.provider,
      providerRefId: input.providerRefId,
      amountReceivedCents: receivedCents,
      walletAppliedCents: creditUsedCents,
    },
  });

  // ═══ AND TELL THE PLAYER — AFTER THE CALLER COMMITS ═══
  //
  // Described here and written by the caller, because `notification` is
  // owner-only on `app.user_id` and this function runs under whatever binding
  // it was handed. Checkout's is a TENANT binding, so the INSERT would fail
  // the policy's WITH CHECK and take the payment transaction down with it.
  //
  // It also has to come after the commit rather than before it: a banner on
  // the phone for a booking whose transaction then rolled back is the
  // push-then-persist failure the notifications module refuses by design.
  //
  // A guest booking has nobody to notify. That is not a failure — the guest
  // gave an email, and email is the channel they get.
  const notify: LocalisedNotifyInput | undefined = booking.bookedByUserId
    ? {
        tenantId: booking.tenantId,
        userId: booking.bookedByUserId,
        kind: 'BOOKING_CONFIRMED',
        // A KEY, not a sentence. This code cannot know what language to write
        // in — a Stripe webhook has no user and no request locale. The
        // recipient's own `User.locale` decides, and is read at send time.
        messageKey: 'bookingConfirmed',
        // Cents, formatted in the recipient's locale rather than here.
        // Bulgarian writes "24,00 €", not "€24.00".
        money: {
          amount: { cents: receivedCents + creditUsedCents, currency: booking.currency },
        },
        href: `/bookings/${booking.id}`,
        refType: 'booking',
        refId: booking.id,
      }
    : undefined;

  return { handled: true, bookingId: booking.id, reason: 'confirmed', notify };
}

/** Minor units to a displayable string. `2400, 'eur'` → `24.00 EUR`. */
function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
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
      // Who to tell. Null for a guest booking.
      bookedByUserId: true,
    },
  });

  // Not ours, or a payment for something that is not a booking. Acknowledged
  // rather than retried — Stripe cannot fix this by sending it again, and
  // there is no booking to attach a Payment row to (bookingId is required).
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

  // `spendCredit` records the spend as a NEGATIVE deltaCents with
  // refType 'booking' — there is no bookingId column on the ledger, so the
  // polymorphic ref is the link.
  const walletApplied = await db.creditLedgerEntry.aggregate({
    where: {
      tenantId: booking.tenantId,
      refType: 'booking',
      refId: booking.id,
      reason: 'SPEND',
    },
    _sum: { deltaCents: true },
  });

  return recordPaymentAndConfirm(db, {
    booking,
    provider: 'STRIPE',
    providerRefId: intent.id,
    receivedCents: intent.amount_received ?? 0,
    creditUsedCents: Math.abs(walletApplied._sum?.deltaCents ?? 0),
  });
}
