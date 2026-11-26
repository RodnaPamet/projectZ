/**
 * Security response headers for the request/response boundary.
 *
 * These headers are applied in middleware to every response, providing
 * defence-in-depth alongside the next.config.js headers() configuration.
 *
 * next.config.js headers apply to page routes served by Next.js,
 * but do NOT cover:
 *   - API route responses intercepted by middleware
 *   - Middleware-generated redirects/error responses
 *   - Preflight (OPTIONS) responses
 *
 * By also setting headers in middleware, we guarantee coverage for ALL
 * response types regardless of how Next.js routes them.
 *
 * @see https://securityheaders.com for scoring criteria
 * @see next.config.js headers() for the static page-route headers
 */

/**
 * Security headers applied to every response via middleware.
 *
 * HSTS is environment-aware:
 *   - Production: max-age=1 year, includeSubDomains, preload
 *   - Non-production: max-age=0 (no caching of HSTS policy)
 */
export function getSecurityHeaders(isProduction: boolean): Record<string, string> {
  return {
    // ── Transport Security ──
    'Strict-Transport-Security': isProduction
      ? 'max-age=31536000; includeSubDomains; preload'
      : 'max-age=0',

    // ── Framing Protection ──
    // DENY = never allow framing. Use SAMEORIGIN if embedding in own iframes.
    'X-Frame-Options': 'DENY',

    // ── MIME Sniffing Protection ──
    'X-Content-Type-Options': 'nosniff',

    // ── Referrer Leakage Prevention ──
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // ── Feature Policy ──
    // Geolocation for this origin only (#697): «Близо до мен» on /venues asks
    // the browser where the person is, and `geolocation=()` refused it on
    // every page before the prompt could show. No frame of another origin
    // gets it, and camera, microphone and topics stay off. The fix is rounded
    // to ~100 m, sent only to GET /api/v1/venues/near, and never stored.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), browsing-topics=()',

    // ── Cross-Origin Isolation ──
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/**
 * Apply security headers to a response (or Headers object).
 */
export function applySecurityHeaders(headers: Headers, isProduction: boolean): void {
  const securityHeaders = getSecurityHeaders(isProduction);
  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }
}
