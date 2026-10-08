/**
 * Columns the personal-data export (#370) must never carry, by name: every
 * secret and credential in the schema, and the payment keys. Shared by the
 * guardrail that reads the export's source
 * (tests/guardrails/data-export-excludes-secrets.test.ts) and the integration
 * test that reads a real file (tests/integration/data-export.test.ts).
 *
 * Not here, on purpose (#370 review): a session's IP address and user agent,
 * and the contact details a club's desk took on a booking the person made.
 * Those are the person's own, and the export carries them. The integration
 * test checks that nobody ELSE's appear.
 */
export const EXPORT_EXCLUDED_COLUMNS = [
  // Sign-in credentials and the second factor.
  'passwordHash',
  'mfaSecret',
  'mfaLastUsedStep',
  'codeHash',
  'sessionVersion',
  // Session and refresh tokens.
  'tokenHash',
  'refreshTokenHash',
  'previousRefreshTokenHash',
  'sessionSecret',
  // Push and device credentials.
  'endpoint',
  'p256dh',
  'auth',
  'deviceToken',
  // Wearable tokens.
  'accessTokenEnc',
  'refreshTokenEnc',
  // Payment and retry keys.
  'stripePaymentIntentId',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'paymentIntentId',
  'idempotencyKey',
  // Other people: the address a share of a booking's price was sent to.
  'inviteEmail',
] as const;
