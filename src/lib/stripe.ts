import Stripe from 'stripe';

/**
 * The Stripe client + webhook verifier.
 *
 * `constructEvent` is the ONLY thing standing between your booking table
 * and anyone on the internet who can POST JSON. A webhook handler that
 * trusts its body is a handler where a stranger marks bookings as paid.
 */
let client: Stripe | undefined;

/**
 * Whether this server can call Stripe at all: its secret key is set (#651).
 * Production and staging run without one until the owner adds the keys
 * (#581). A call made without one can only fail at Stripe, so the club's
 * «Онлайн плащания» card is not shown and onboarding refuses up front.
 */
export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripe(): Stripe {
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
      apiVersion: '2025-02-24.acacia' as never,
      maxNetworkRetries: 2,

      // Use fetch rather than the SDK's default Node `http` transport.
      //
      // Two reasons, and the second is the important one:
      //
      //   1. It is the transport that works everywhere — Node, edge, workers.
      //
      //   2. It is the transport our TESTS can see. MSW intercepts fetch; it
      //      does not reliably intercept the SDK's raw `http.request`. With the
      //      default client, every Stripe handler in tests/helpers/msw.ts was
      //      silently bypassed — the SDK went to the real network, the tests
      //      hung, and nothing was asserting on what we actually send Stripe.
      //
      //      Pinning this here means the code path under test is the SAME code
      //      path that runs in production. A test that exercises a different
      //      transport than production is not testing production.
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return client;
}

export class WebhookSignatureError extends Error {
  readonly code = 'invalid_signature';
  constructor(cause: string) {
    super(`Stripe webhook signature verification failed: ${cause}`);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * Verify and parse. Never `JSON.parse(body)` in the handler.
 *
 * The signature also covers a TIMESTAMP, which is what makes a replay
 * attack fail — an attacker who captures a legitimate `payment_intent
 * .succeeded` cannot re-send it tomorrow to confirm a different booking.
 * That protection is lost the moment anyone "just parses the body to check
 * something first".
 */
/**
 * ═══ TWO ENDPOINTS, TWO SECRETS ═══
 *
 * Stripe sends a connected account's events (a club's `account.updated`,
 * which is what sets `payoutsEnabled`, #581) only to an endpoint that listens
 * on connected accounts, and the platform's own (`checkout.session.*`,
 * `payment_intent.succeeded`) only to one that does not. Each endpoint has its
 * own signing secret. Both point at this route, so a payload is accepted when
 * EITHER secret verifies it: `STRIPE_WEBHOOK_SECRET` (platform) or
 * `STRIPE_CONNECT_WEBHOOK_SECRET` (connected accounts). Neither verifying is
 * the same refusal as before.
 */
export function verifyStripeWebhook(rawBody: string, signatureHeader: string | null): Stripe.Event {
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  ].filter((s): s is string => !!s);
  if (secrets.length === 0) throw new WebhookSignatureError('STRIPE_WEBHOOK_SECRET is not set');
  if (!signatureHeader) throw new WebhookSignatureError('missing stripe-signature header');

  let last: unknown;
  for (const secret of secrets) {
    try {
      return stripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
    } catch (e) {
      last = e;
    }
  }
  throw new WebhookSignatureError(last instanceof Error ? last.message : 'unknown');
}
