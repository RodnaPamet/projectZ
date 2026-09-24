import type { PlanTier } from '@prisma/client';

import { stripe } from '@/lib/stripe';

import { platformFeeCents } from './platform-fee';

/**
 * Stripe Connect.
 *
 * ─── Why DESTINATION charges, not separate charges + transfers ───────
 *
 * The money is charged on OUR platform account and settled to the venue's
 * connected account in a single atomic operation, with our commission taken
 * out via `application_fee_amount`.
 *
 * The alternative — charge the customer, then transfer to the venue in a
 * second call — has a window between the two. If the process dies in that
 * window, we are holding money that belongs to a club, with nothing in Stripe
 * saying so. Reconciling that by hand is somebody's very bad week.
 *
 * With a destination charge, there is no window. Stripe either did both or
 * neither.
 *
 * ─── Why `on_behalf_of` ──────────────────────────────────────────────
 *
 * It makes the VENUE the merchant of record: their name on the customer's card
 * statement, their country's settlement rules, their Stripe fees. Without it
 * the customer sees *our* name for a court they booked at their local club,
 * which is both confusing and a dispute waiting to happen.
 */

export class PayoutsNotEnabledError extends Error {
  readonly code = 'payouts_not_enabled';
  constructor(readonly venueName: string) {
    super(`${venueName} has not finished Stripe onboarding, so it cannot receive payouts yet.`);
    this.name = 'PayoutsNotEnabledError';
  }
}

/** Begin (or resume) onboarding. Returns the URL to send the club admin to. */
export async function createOnboardingLink(input: {
  stripeAccountId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<string> {
  const link = await stripe().accountLinks.create({
    account: input.stripeAccountId,
    type: 'account_onboarding',
    return_url: input.returnUrl,
    // Stripe's onboarding links EXPIRE, and a user who takes too long lands on
    // a dead page. `refresh_url` is where Stripe sends them so we can mint a
    // fresh link, rather than showing them an error they cannot act on.
    refresh_url: input.refreshUrl,
  });

  return link.url;
}

export async function createConnectedAccount(input: {
  email: string;
  venueName: string;
  country: string;
  /**
   * Stripe dedupes on this, and it is not optional.
   *
   * Creating a connected account is an EXTERNAL side effect that our database
   * cannot roll back. Two admins clicking "set up payouts" at the same moment
   * would otherwise create two Express accounts, of which we could store only
   * one id — the other is orphaned in the club's Stripe dashboard, may be
   * partially onboarded, and nothing in this application knows it exists.
   *
   * Keyed on the tenant, so both requests resolve to the same account.
   */
  idempotencyKey: string;
}): Promise<string> {
  const account = await stripe().accounts.create(
    {
      type: 'express',
      country: input.country,
      email: input.email,
      business_profile: { name: input.venueName },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    },
    { idempotencyKey: input.idempotencyKey },
  );

  return account.id;
}

export interface DestinationChargeInput {
  totalCents: number;
  currency: string;
  tier: PlanTier;
  stripeAccountId: string;
  bookingId: string;
  /** Stripe dedupes on this. See below — it is not optional. */
  idempotencyKey: string;
}

/**
 * A destination charge with our commission attached.
 *
 * The idempotency key is REQUIRED rather than defaulted. Stripe retries on
 * network failure (`maxNetworkRetries: 2`), and a retried POST without a key
 * creates a SECOND payment intent — the customer is charged twice for one
 * booking. Making the caller supply the key means they have to think about
 * what makes this charge unique, which is exactly the thought that prevents
 * the double charge.
 */
export async function createDestinationCharge(input: DestinationChargeInput) {
  const fee = platformFeeCents(input.totalCents, input.tier);

  return stripe().paymentIntents.create(
    {
      amount: input.totalCents,
      currency: input.currency.toLowerCase(),

      // Our cut. Stripe moves `total - fee` to the venue and keeps `fee` on
      // the platform account. We never touch the venue's share.
      application_fee_amount: fee,

      transfer_data: { destination: input.stripeAccountId },
      on_behalf_of: input.stripeAccountId,

      // Reconciliation. When a club emails asking which booking a payout line
      // belongs to, this is the answer — without it, the only link between a
      // Stripe payout and our database is a timestamp and a hope.
      metadata: {
        bookingId: input.bookingId,
        platformFeeCents: String(fee),
      },
    },
    { idempotencyKey: input.idempotencyKey },
  );
}

/**
 * Refund, reversing the venue's transfer PROPORTIONALLY.
 *
 * `reverse_transfer: true` claws back the venue's share; `refund_application_fee`
 * gives back our commission on the refunded portion.
 *
 * Omitting `reverse_transfer` refunds the CUSTOMER out of the PLATFORM's
 * balance while the venue keeps the whole payout — we would be paying for the
 * club's cancellations out of our own pocket, and the shortfall only surfaces
 * when our Stripe balance goes negative.
 */
/**
 * Fetch an existing PaymentIntent.
 *
 * Needed because `client_secret` is not stored — it is returned once at
 * creation and a client that lost it (app relaunched, sheet dismissed) has no
 * way back to the charge it was already shown without this.
 */
export async function retrievePaymentIntent(paymentIntentId: string) {
  return stripe().paymentIntents.retrieve(paymentIntentId);
}

export async function refundWithFeeReversal(input: {
  paymentIntentId: string;
  refundCents: number;
  /** How much of our fee to give back. See `refundSplit`. */
  feeReversedCents: number;
  idempotencyKey: string;
}) {
  return stripe().refunds.create(
    {
      payment_intent: input.paymentIntentId,
      amount: input.refundCents,
      reverse_transfer: true,
      // Stripe reverses the fee proportionally to the refunded amount when
      // this is set, which matches `refundSplit`'s arithmetic exactly. We send
      // our computed figure in metadata so a mismatch is VISIBLE in the
      // dashboard rather than silently absorbed.
      refund_application_fee: true,
      metadata: { expectedFeeReversedCents: String(input.feeReversedCents) },
    },
    { idempotencyKey: input.idempotencyKey },
  );
}
