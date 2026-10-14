import { stripe } from '@/lib/stripe';

/**
 * A tournament entry's fee, paid online (#581; decisions 41, 64, 66).
 *
 * ═══ HOSTED CHECKOUT, NOT A CARD FORM OF OUR OWN ═══
 *
 * The web has no Stripe in the browser, and the app opens the same page: a
 * Stripe Checkout Session is a page on checkout.stripe.com that takes the
 * card, runs 3-D Secure, and sends the player back. No card detail reaches
 * playerz, no Stripe script loads on our pages, and the CSP does not change.
 *
 * ═══ THE MONEY IS THE CLUB'S ═══
 *
 * A destination charge to the club's connected account, with NO application
 * fee: playerz's cut is not taken here. It goes on the club's monthly
 * statement as its own line (decision 42, 66), like the booking fee, so a
 * refund is the whole fee back from the club and nothing for us to reverse.
 */

export interface EntryCheckoutInput {
  entryId: string;
  tournamentName: string;
  amountCents: number;
  currency: string;
  /** The club's connected account (`venue_org.stripeAccountId`). */
  stripeAccountId: string;
  /** Where Stripe sends the player back. */
  successUrl: string;
  cancelUrl: string;
  /** When the page stops taking payment (Stripe allows 30 minutes to 24 hours). */
  expiresAt: Date;
  customerEmail: string | null;
  locale: 'bg' | 'en';
  /** Stripe dedupes on this: one session per entry and deadline. */
  idempotencyKey: string;
}

export async function createEntryCheckoutSession(input: EntryCheckoutInput) {
  return stripe().checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountCents,
            product_data: { name: input.tournamentName },
          },
        },
      ],
      payment_intent_data: {
        transfer_data: { destination: input.stripeAccountId },
        on_behalf_of: input.stripeAccountId,
        // Reconciliation, for a club asking which entry a payout line is.
        metadata: { tournamentEntryId: input.entryId },
      },
      // Read back only as a cross-check: the webhook finds the entry by the
      // session id stored on our own row, never by what Stripe hands back.
      metadata: { tournamentEntryId: input.entryId },
      client_reference_id: input.entryId,
      expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      locale: input.locale,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    },
    { idempotencyKey: input.idempotencyKey },
  );
}

/**
 * The whole fee back to the player, taken back from the club's account
 * (`reverse_transfer`): without it the refund would come out of playerz's
 * balance while the club kept the payout.
 */
export async function refundEntryFee(input: {
  paymentIntentId: string;
  amountCents: number;
  entryId: string;
  idempotencyKey: string;
}) {
  return stripe().refunds.create(
    {
      payment_intent: input.paymentIntentId,
      amount: input.amountCents,
      reverse_transfer: true,
      metadata: { tournamentEntryId: input.entryId },
    },
    { idempotencyKey: input.idempotencyKey },
  );
}
