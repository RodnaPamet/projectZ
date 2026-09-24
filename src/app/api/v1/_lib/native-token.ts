import { encode } from 'next-auth/jwt';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/sessions';

/**
 * Minting an access token a Swift client can actually use.
 *
 * ═══ WHY THE ACCESS TOKEN IS SHORT ═══
 *
 * The edge middleware never checks revocation. `middleware.ts` reads the token
 * and inspects its CLAIMS — `checkTenantAccess` is pure claim inspection, and
 * `checkSession` runs only inside a route via `contextFromRequest`.
 *
 * So `exp` is the only revocation the edge honours. A revoked session still
 * clears the tenant-membership and permission checks until its token expires,
 * and a long access token is exactly that window. 15 minutes bounds it;
 * the refresh token carries the long-lived part and is checked against the
 * database on every use.
 *
 * ═══ WHY expiresAt IS IN THE BODY ═══
 *
 * The JWE header is {"alg":"dir","enc":"A256GCM"} — the payload is ENCRYPTED.
 * A client cannot read `exp`, or anything else, out of this token. It is an
 * opaque string to Swift, so the expiry has to be told to it separately.
 *
 * And `encode()` overwrites any `exp` you put in the payload — it calls
 * `.setExpirationTime(now + maxAge)` after the claims — so `maxAge` is the only
 * lever, and the body's expiry must be computed from the same constant in the
 * same request or the two disagree.
 */

export interface NativeTokens {
  tokenType: 'Bearer';
  accessToken: string;
  /** RFC3339, NO fractional seconds. See rfc3339(). */
  expiresAt: string;
  /** Seconds. Belt and braces: a client that does its own clock maths needs no parsing. */
  expiresIn: number;
  /** Null from /refresh inside the grace window: "keep the one you have". */
  refreshToken: string | null;
  /**
   * The SESSION ROW's expiry, which is the deadline refresh is judged against.
   *
   * Fixed when the session is created and never extended — refreshing does not
   * move it, so this value counts DOWN across responses rather than sliding
   * forward. A client may schedule re-authentication against it.
   */
  refreshExpiresAt: string;
}

/**
 * RFC3339 WITHOUT fractional seconds.
 *
 * `new Date().toISOString()` gives `2026-09-21T14:13:20.123Z`. Swift's
 * `JSONDecoder.DateDecodingStrategy.iso8601` is `ISO8601DateFormatter` with
 * `.withInternetDateTime` only, and it REJECTS the fractional form — failing at
 * the decoder, so the error names the whole response rather than the field.
 *
 * Truncating rounds an expiry DOWN, which is the safe direction: a client
 * refreshes a fraction of a second early rather than a fraction late.
 */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * ═══ NATIVE ACCESS TOKENS CARRY NO sessionSecret, ON PURPOSE ═══
 *
 * `checkSession` compares a token's `sessionSecret` against the row's
 * `tokenHash`. That column binds the WEB cookie, and refresh deliberately does
 * not rotate it — rotating it would invalidate every access token already in
 * flight.
 *
 * So a refreshed access token cannot carry a secret that matches: the server
 * stores only the hash and cannot recover the plaintext. Minting a NEW random
 * secret and putting it in the token produces an access token that
 * `checkSession` rejects as `unknown` on its first use — refresh appears to
 * succeed and the token it returns does not work.
 *
 * `checkSession` only applies the binding `if (claims.sessionSecret)`, so
 * omitting it is a supported path, not a hole: the session is still validated
 * by userSessionId, revokedAt, expiresAt and sessionVersion on every request.
 * The binding was always belt and braces — the JWE is encrypted and signed
 * with NEXTAUTH_SECRET, so a forged userSessionId cannot be presented anyway.
 *
 * Both native endpoints omit it, because carrying it on sign-in and not on
 * refresh is the kind of asymmetry that reads as a bug and gets "fixed".
 */
export async function mintAccessToken(claims: {
  sub: string;
  userSessionId: string;
  sessionVersion: number;
}): Promise<{ accessToken: string; expiresAt: Date }> {
  const accessToken = await encode({
    secret: process.env.NEXTAUTH_SECRET!,
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
    token: claims,
  });

  return {
    accessToken,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
  };
}

/**
 * The session ROW outlives the access token — it is scoped to the refresh
 * window, and its `expiresAt` IS the refresh deadline the server enforces.
 *
 * Derived from REFRESH_TOKEN_TTL_SECONDS rather than repeating 30 days, so the
 * row cannot end up shorter than the window it exists to cover: a refresh token
 * outliving its own session row would be refused as `expired` before its
 * advertised deadline.
 */
export const NATIVE_SESSION_TTL_SECONDS = Math.max(
  SESSION_MAX_AGE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
);
