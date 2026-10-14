/**
 * @jest-environment node
 */
import { WebhookSignatureError, verifyStripeWebhook } from '@/lib/stripe';

import { paymentIntentSucceeded, signStripeWebhook } from '../../helpers/stripe-webhook';

/**
 * The webhook signature is the ONLY thing between the booking table and
 * anyone on the internet who can POST JSON. A handler that trusts its body
 * is a handler where a stranger marks bookings as paid.
 *
 * These run through the REAL Stripe verifier, not a stub. A test that mocks
 * `constructEvent` proves nothing about the defence it claims to test — you
 * cannot demonstrate a forgery is caught unless the genuine article passes
 * through the same code.
 */
describe('Stripe webhook verification', () => {
  const event = paymentIntentSucceeded({
    paymentIntentId: 'pi_1',
    bookingId: 'bk_1',
    amountCents: 2400,
  });

  it('accepts a genuinely signed payload', () => {
    const { payload, header } = signStripeWebhook(event);
    expect(verifyStripeWebhook(payload, header).type).toBe('payment_intent.succeeded');
  });

  it('REJECTS a tampered amount', () => {
    const { payload, header } = signStripeWebhook(event);
    // The attacker inflates the amount but cannot re-sign it.
    const tampered = payload.replace('"amount":2400', '"amount":1');
    expect(() => verifyStripeWebhook(tampered, header)).toThrow(WebhookSignatureError);
  });

  it('REJECTS a payload signed with the wrong secret', () => {
    const { payload, header } = signStripeWebhook(event, { secret: 'whsec_attacker' });
    expect(() => verifyStripeWebhook(payload, header)).toThrow(WebhookSignatureError);
  });

  it('accepts the connected-accounts endpoint’s secret too, and still nothing else (#581)', () => {
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect_test'; // pragma: allowlist secret
    try {
      // A made-up test secret, set just above. pragma: allowlist secret
      const connect = signStripeWebhook(event, { secret: 'whsec_connect_test' }); // pragma: allowlist secret
      expect(verifyStripeWebhook(connect.payload, connect.header).type).toBe(
        'payment_intent.succeeded',
      );
      const forged = signStripeWebhook(event, { secret: 'whsec_attacker' });
      expect(() => verifyStripeWebhook(forged.payload, forged.header)).toThrow(
        WebhookSignatureError,
      );
    } finally {
      delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    }
  });

  it('REJECTS a missing signature header outright', () => {
    const { payload } = signStripeWebhook(event);
    expect(() => verifyStripeWebhook(payload, null)).toThrow(/missing stripe-signature/);
  });

  it('REJECTS a REPLAYED payload from outside the tolerance window', () => {
    // The signature covers a TIMESTAMP. That is what stops an attacker who
    // captured a legitimate payment_intent.succeeded from re-sending it
    // tomorrow to confirm a different booking.
    //
    // The protection is lost the moment anyone "just parses the body to
    // check something first".
    const old = Math.floor(Date.now() / 1000) - 7200;
    const { payload, header } = signStripeWebhook(event, { timestamp: old });
    expect(() => verifyStripeWebhook(payload, header)).toThrow(WebhookSignatureError);
  });

  it('a fresh timestamp within tolerance is accepted', () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    const { payload, header } = signStripeWebhook(event, { timestamp: recent });
    expect(() => verifyStripeWebhook(payload, header)).not.toThrow();
  });
});
