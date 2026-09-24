import { createHash } from 'node:crypto';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * MSW handlers for the third-party edges: Stripe, Resend, HIBP.
 *
 * These intercept at the HTTP layer rather than stubbing the SDK objects.
 * That distinction matters: stubbing `stripe.paymentIntents.create` proves
 * only that we call a function we wrote; intercepting the request proves
 * we send Stripe a well-formed body — and lets a test assert on the
 * amount, currency and idempotency key that actually go over the wire.
 */

/**
 * Every request MSW intercepted this run, for assertions.
 *
 * Headers are recorded as well as the body, because some guarantees live
 * ONLY in a header — an `Idempotency-Key` on a Stripe POST is the difference
 * between two simultaneous clicks creating one connected account and creating
 * two, and there is no way to observe that from the body.
 */
export const recorded: Array<{
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}> = [];

async function record(request: Request) {
  let body: unknown = null;
  try {
    const text = await request.clone().text();
    body = text.startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
  } catch {
    body = null;
  }

  // Lower-cased keys: Headers normalises on read, and a test asserting
  // `Idempotency-Key` should not fail because the SDK sent `idempotency-key`.
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  recorded.push({ url: request.url, method: request.method, body, headers });
  return body;
}

/**
 * Configurable HIBP response.
 *
 * The real range API returns `SUFFIX:COUNT` lines and the caller scans for
 * ITS OWN sha1 suffix. So a handler that returns an arbitrary suffix never
 * matches — the test would silently assert "not breached" no matter what.
 * `setHibpPwned` therefore takes the actual password and computes the
 * suffix the caller will look for.
 */
let hibpPwnedSuffix: string | null = null;
let hibpPwnedCount = 0;

export function setHibpPwned(password: string, count: number) {
  hibpPwnedSuffix = createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase()
    .slice(5);
  hibpPwnedCount = count;
}

/** No password is breached. */
export function setHibpClean() {
  hibpPwnedSuffix = null;
  hibpPwnedCount = 0;
}

/**
 * What the moderation classifier says next.
 *
 * Set per-test. Reset to clean in afterEach, so a test that forgets to reset
 * cannot leave a poisoned classifier for the next one.
 */
let moderationScores: Record<string, number> = {};

/**
 * Tests write CANONICAL category names (`sexual/minors`), because that is the
 * policy vocabulary and it is what they read as. The API cannot carry a slash
 * in a tool property key, so the real response comes back with WIRE names
 * (`sexual_minors`) — and the mock must emit what the real thing emits, or a
 * test proves nothing about the parser.
 */
const TO_WIRE = (scores: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(scores).map(([k, v]) => [k.replace(/[/-]/g, '_'), v]));

export function setModerationScores(scores: Record<string, number>) {
  moderationScores = TO_WIRE(scores);
}

export function setModerationClean() {
  moderationScores = TO_WIRE({ harassment: 0.01, violence: 0.001, 'sexual/minors': 0.0001 });
}
setModerationClean();

/** What Strava returns from /athlete/activities next. */
let stravaActivities: unknown[] = [];
let stravaRefreshCount = 0;

export function setStravaActivities(activities: unknown[]) {
  stravaActivities = activities;
}

/** PaymentIntents created this run, so RETRIEVE mirrors CREATE like Stripe. */
const createdIntents = new Map<string, Record<string, unknown>>();

export const handlers = [
  // ── Stripe ────────────────────────────────────────────────────────
  http.post('https://api.stripe.com/v1/payment_intents', async ({ request }) => {
    const body = (await record(request)) as Record<string, string> | null;
    const id = `pi_test_${Math.random().toString(36).slice(2, 12)}`;

    // Remembered so a RETRIEVE returns what was CREATED, as Stripe does. A
    // retrieve handler that invents a response cannot support any test about
    // resuming an existing checkout — it would return an amount nobody
    // charged, and the test would be asserting against the mock's imagination.
    const intent = {
      id,
      object: 'payment_intent',
      amount: Number(body?.amount ?? 0),
      currency: body?.currency ?? 'eur',
      status: 'requires_payment_method',
      client_secret: `${id}_secret_test`,
      // Echo the Connect fields back. Stripe form-encodes nested params, so
      // `transfer_data[destination]` arrives as a FLAT key — a test asserting
      // on `body.transfer_data.destination` would read `undefined` and pass
      // for the wrong reason.
      application_fee_amount: body?.application_fee_amount
        ? Number(body.application_fee_amount)
        : null,
      transfer_data: body?.['transfer_data[destination]']
        ? { destination: body['transfer_data[destination]'] }
        : null,
      on_behalf_of: body?.on_behalf_of ?? null,
      metadata: body?.['metadata[bookingId]'] ? { bookingId: body['metadata[bookingId]'] } : {},
    };

    createdIntents.set(id, intent);
    return HttpResponse.json(intent);
  }),

  http.get('https://api.stripe.com/v1/payment_intents/:id', ({ params }) => {
    const known = createdIntents.get(String(params.id));
    if (known) return HttpResponse.json(known);

    // Unknown to this run: a plausible shape rather than a 404, so a test that
    // did not create the intent still gets something decodable.
    return HttpResponse.json({
      id: params.id,
      object: 'payment_intent',
      amount: 0,
      status: 'requires_payment_method',
      client_secret: `${params.id}_secret_test`,
    });
  }),

  http.post('https://api.stripe.com/v1/refunds', async ({ request }) => {
    const body = (await record(request)) as Record<string, string> | null;
    return HttpResponse.json({
      id: `re_test_${Math.random().toString(36).slice(2, 12)}`,
      object: 'refund',
      amount: Number(body?.amount ?? 0),
      payment_intent: body?.payment_intent ?? null,
      status: 'succeeded',
    });
  }),

  // ── Stripe Connect ────────────────────────────────────────────────
  //
  // A connected account starts with payouts DISABLED — which is the real
  // behaviour, and the one that matters. An express account cannot receive
  // a destination charge until the club has finished onboarding, and a mock
  // that returns `payouts_enabled: true` immediately would let the
  // "charge an un-onboarded venue" bug pass every test we have.
  http.post('https://api.stripe.com/v1/accounts', async ({ request }) => {
    await record(request);
    return HttpResponse.json({
      id: `acct_test_${Math.random().toString(36).slice(2, 12)}`,
      object: 'account',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    });
  }),

  http.post('https://api.stripe.com/v1/account_links', async ({ request }) => {
    await record(request);
    return HttpResponse.json({
      object: 'account_link',
      url: 'https://connect.stripe.com/setup/e/acct_test/onboarding',
      expires_at: 1893456000,
    });
  }),

  http.post('https://api.stripe.com/v1/subscriptions', async ({ request }) => {
    await record(request);
    return HttpResponse.json({
      id: `sub_test_${Math.random().toString(36).slice(2, 12)}`,
      object: 'subscription',
      status: 'active',
    });
  }),

  http.post('https://api.stripe.com/v1/checkout/sessions', async ({ request }) => {
    await record(request);
    const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
    return HttpResponse.json({
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/${id}`,
    });
  }),

  // ── Claude (moderation) ───────────────────────────────────────────
  //
  // Mirrors the real Messages API shape: the model answers with a `tool_use`
  // content block, NOT with text. A mock that returned `{scores: {...}}` at the
  // top level would let a parser bug — reading the wrong shape entirely — pass
  // every test we have.
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    await record(request);
    return HttpResponse.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_test',
          name: 'report_moderation_scores',
          input: moderationScores,
        },
      ],
    });
  }),

  // ── Strava ────────────────────────────────────────────────────────
  http.post('https://www.strava.com/oauth/token', async ({ request }) => {
    await record(request);
    return HttpResponse.json({
      // A fixed string returned by our own mock — no real Strava token exists in
      // this repository.
      access_token: 'strava_access_refreshed', // pragma: allowlist secret
      // Strava ROTATES the refresh token on every refresh. A mock that returned
      // the SAME one would let the "we forgot to store the new refresh token"
      // bug pass every test — and in production the athlete would silently stop
      // syncing on the second refresh.
      refresh_token: `strava_refresh_${stravaRefreshCount++}`,
      expires_at: Math.floor(Date.now() / 1000) + 21_600,
    });
  }),

  http.get('https://www.strava.com/api/v3/athlete/activities', async ({ request }) => {
    await record(request);
    return HttpResponse.json(stravaActivities);
  }),

  // ── Resend ────────────────────────────────────────────────────────
  http.post('https://api.resend.com/emails', async ({ request }) => {
    await record(request);
    return HttpResponse.json({ id: `mock-${Math.random().toString(36).slice(2, 12)}` });
  }),

  // ── HIBP (k-anonymity range API) ──────────────────────────────────
  http.get('https://api.pwnedpasswords.com/range/:prefix', () => {
    // The real API returns `SUFFIX:COUNT` lines, padded with decoys that
    // carry count 0. Always emit a decoy so the "padding is not a hit"
    // path is exercised on every call.
    const lines = [`${'0'.repeat(35)}:0`];
    if (hibpPwnedSuffix) lines.push(`${hibpPwnedSuffix}:${hibpPwnedCount}`);
    return HttpResponse.text(lines.join('\r\n'));
  }),
];

export const mswServer = setupServer(...handlers);

/** Wire MSW into a jest suite: strict, and reset between tests. */
export function useMswServer() {
  beforeAll(() => {
    // `error` — an unhandled outbound request is a bug, not a warning. A
    // test that silently reaches the real Stripe would be far worse than
    // one that fails loudly here.
    mswServer.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    mswServer.resetHandlers();
    recorded.length = 0;
    setHibpClean();
    setModerationClean();
    stravaActivities = [];
  });

  afterEach(() => {
    createdIntents.clear();
  });

  afterAll(() => {
    mswServer.close();
  });
}

/** Find a recorded request by URL fragment. */
export function findRequest(fragment: string) {
  return recorded.find((r) => r.url.includes(fragment));
}
