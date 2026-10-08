/**
 * Columns the personal-data export (#370) must never carry, by name: every
 * secret and credential in the schema, the request metadata of other systems,
 * and the payment keys. Shared by the guardrail that reads the export's source
 * (tests/guardrails/data-export-excludes-secrets.test.ts) and the integration
 * test that reads a real file (tests/integration/data-export.test.ts).
 */
export const EXPORT_EXCLUDED_COLUMNS = [
  // Sign-in credentials and the second factor.
  'passwordHash',
  'mfaSecret',
  'mfaLastUsedStep',
  'codeHash',
  'sessionVersion',
  // Session and refresh tokens, and where a session came from.
  'tokenHash',
  'refreshTokenHash',
  'previousRefreshTokenHash',
  'sessionSecret',
  'ipAddress',
  'userAgent',
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
  // Other people, by the columns that name them on a booking.
  'guestEmail',
  'guestPhone',
  'guestName',
  'inviteEmail',
] as const;
