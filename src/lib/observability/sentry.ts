/**
 * Sentry Error Reporting — server-side integration.
 *
 * Provides a thin wrapper around @sentry/nextjs for error capture with
 * requestId correlation and safe metadata. Noop when SENTRY_DSN is not set.
 *
 * SAFETY:
 *   - beforeSend strips authorization headers, cookies, and request bodies
 *   - Expected 4xx errors are not reported
 *   - Never sends secrets, tokens, or raw payloads
 *
 * ENV VARS:
 *   SENTRY_DSN                  — Sentry project DSN (noop if missing)
 *   SENTRY_ENVIRONMENT          — environment tag (default: NODE_ENV)
 *   SENTRY_TRACES_SAMPLE_RATE   — performance sample rate (default: 0 — use OTel)
 */

import * as Sentry from '@sentry/nextjs';
import { getRequestContext } from './context';

// ── State ──

let _initialized = false;

// ── Sensitive URL query params to redact ──

/**
 * Headers that must never reach Sentry.
 *
 * Compared LOWERCASE, because HTTP header names are case-insensitive and a
 * client that sends `Authorization` (the conventional casing, and what every
 * HTTP library emits) would otherwise sail straight past a lowercase key lookup
 * — shipping the bearer token to a third party.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'proxy-authorization',
  'stripe-signature',
]);

const SENSITIVE_PARAMS = new Set([
  // Where a person stood, for «Близо до мен» (#697): `GET /venues/near?lat=&lng=`.
  // Rounded to ~100 m by the page, and still nobody's business but the search.
  'lat',
  'lng',
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'secret',
  'SAMLResponse',
  'RelayState',
]);

// ── Errors to ignore (expected / handled) ──

const IGNORED_ERROR_PATTERNS = ['NEXT_REDIRECT', 'NEXT_NOT_FOUND', 'DYNAMIC_SERVER_USAGE'];

/**
 * Redact sensitive query parameters from a URL string.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://placeholder');
    for (const param of SENSITIVE_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[Redacted]');
      }
    }
    // Return without the placeholder origin if original was relative
    return url.startsWith('http') ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Initialize Sentry SDK. Safe to call multiple times — only initializes once.
 * Noop when SENTRY_DSN is not set.
 */
/**
 * Strip everything that must never leave the building.
 *
 * ─── Why this is exported, and tested ────────────────────────────────
 *
 * A `beforeSend` buried in an init call is a function nobody ever runs. It looks
 * right in review and it is never exercised, so a gap in it is discovered by an
 * auditor reading our Sentry project — which is the worst possible way to find
 * out that we have been shipping bearer tokens to a third party.
 *
 * So it is a pure function, and real events are run through it.
 *
 * ─── The bug that testing found ──────────────────────────────────────
 *
 * The original did `delete headers['authorization']`.
 *
 * HTTP HEADER NAMES ARE CASE-INSENSITIVE. A client that sends `Authorization`
 * — which is the conventional casing, and what every HTTP library emits — sails
 * straight past a lowercase key lookup, and the bearer token goes to Sentry.
 *
 * The delete "worked" in every test anybody had written, because those tests
 * used lowercase keys.
 */
export function scrubEvent(
  event: Sentry.ErrorEvent,
  hint?: Sentry.EventHint,
): Sentry.ErrorEvent | null {
  const error = hint?.originalException;

  // Expected control-flow "errors" from Next. Not incidents.
  if (error instanceof Error) {
    for (const pattern of IGNORED_ERROR_PATTERNS) {
      if (error.message.includes(pattern) || error.name.includes(pattern)) {
        return null;
      }
    }
  }

  if (event.request) {
    if (event.request.headers) {
      // CASE-INSENSITIVE. See the note above — this is the whole point.
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
        headers[name] = value;
      }
      event.request.headers = headers;
    }

    // The body may contain anything — a password, a card, a whole review.
    // Filtered wholesale rather than field by field: an allowlist of safe fields
    // is a list somebody will add to.
    if (event.request.data) event.request.data = '[Filtered]';
    if (event.request.url) event.request.url = redactUrl(event.request.url);
    if (event.request.query_string) event.request.query_string = '[Filtered]';

    // The cookie header again, by its own name — some SDK versions hoist it out
    // of `headers` into its own field, where the loop above never sees it.
    if ('cookies' in event.request) {
      (event.request as { cookies?: unknown }).cookies = undefined;
    }
  }

  // Sentry attaches a user object. An id is fine and useful; an email or an IP
  // is personal data we did not need in order to fix a stack trace.
  if (event.user) {
    event.user = { id: event.user.id };
  }

  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (crumb.data?.url && typeof crumb.data.url === 'string') {
        crumb.data.url = redactUrl(crumb.data.url);
      }
    }
  }

  return event;
}

export function initSentry(): void {
  if (_initialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    _initialized = true;
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),

    // The scrubber. Extracted so it can be TESTED with real events rather than
    // trusted — see tests/unit/observability/sentry-scrubbing.test.ts.
    beforeSend: scrubEvent,

    // Sentry will otherwise attach the user's IP address and, in some SDKs, their
    // email — to EVERY event, without us ever writing a line of code. An error
    // report is not consent to ship somebody's IP to a third party.
    sendDefaultPii: false,

    // Ignore common noisy errors
    ignoreErrors: [
      'ResizeObserver loop',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error exception captured',
      /^Loading chunk \d+ failed/,
      /^Loading CSS chunk \d+ failed/,
    ],
  });

  _initialized = true;
}

/** Check if Sentry has been initialized with a valid DSN. */
export function isSentryInitialized(): boolean {
  return _initialized;
}

/**
 * Flush pending Sentry events and close the client. Bounded by
 * `timeoutMs` — Sentry.close() takes its own timeout and never
 * throws, but we guard with Promise.race so a misbehaving transport
 * can't block shutdown past the graceful-shutdown budget.
 *
 * Noop when Sentry was never initialised (SENTRY_DSN unset).
 *
 * Safe to call multiple times.
 */
export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
  if (!_initialized) return;
  _initialized = false;

  await Promise.race([
    Sentry.close(timeoutMs).then(() => {
      /* discard boolean */
    }),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 100)),
  ]);
}

/**
 * Capture an error in Sentry with request context correlation.
 *
 * Only captures errors with status >= 500 (server errors).
 * Skips 4xx (client/validation errors) to reduce noise.
 *
 * @param error — the error to capture
 * @param extra — optional metadata (requestId, route, method, status, etc.)
 */
export function captureError(
  error: unknown,
  extra?: {
    requestId?: string;
    route?: string;
    method?: string;
    status?: number;
    tenantId?: string;
    userId?: string;
    errorCode?: string;
  },
): void {
  // Skip 4xx — these are expected/handled
  if (extra?.status && extra.status < 500) return;

  // Auto-enrich from ALS context if extra not provided
  const ctx = getRequestContext();

  Sentry.withScope((scope) => {
    // Tags for filtering in Sentry dashboard
    scope.setTag('requestId', extra?.requestId || ctx?.requestId || 'unknown');
    if (extra?.route || ctx?.route) scope.setTag('route', extra?.route || ctx?.route || '');
    if (extra?.method) scope.setTag('method', extra.method);
    if (extra?.status) scope.setTag('statusCode', String(extra.status));
    if (extra?.errorCode) scope.setTag('errorCode', extra.errorCode);

    // Safe context (never include secrets)
    scope.setContext('request', {
      requestId: extra?.requestId || ctx?.requestId,
      route: extra?.route || ctx?.route,
      method: extra?.method,
      statusCode: extra?.status,
    });

    // User context (Sentry's built-in user tracking — safe fields only)
    const tenantId = extra?.tenantId || ctx?.tenantId;
    const userId = extra?.userId || ctx?.userId;
    if (userId || tenantId) {
      scope.setUser({
        id: userId,
        ...(tenantId && ({ tenantId } as Record<string, string>)),
      });
    }

    if (error instanceof Error) {
      Sentry.captureException(error);
    } else {
      Sentry.captureException(new Error(String(error)));
    }
  });
}

/**
 * Set Sentry scope context from the current request.
 * Useful for enriching errors captured later in the same request lifecycle.
 */
export function setSentryContext(ctx: {
  requestId: string;
  tenantId?: string;
  userId?: string;
  route?: string;
}): void {
  Sentry.setTag('requestId', ctx.requestId);
  if (ctx.route) Sentry.setTag('route', ctx.route);
  if (ctx.tenantId) Sentry.setContext('tenant', { tenantId: ctx.tenantId });
  if (ctx.userId) Sentry.setUser({ id: ctx.userId });
}

/**
 * Reset init flag (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
  _initialized = false;
}
