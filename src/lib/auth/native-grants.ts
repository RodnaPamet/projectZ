import { createHmac } from 'node:crypto';

import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';

import {
  FACEBOOK_GRAPH_VERSION,
  FACEBOOK_USERINFO_FIELDS,
  facebookPictureFrom,
} from '@/lib/auth/facebook';
import { googleAppClientIds } from '@/lib/auth/sign-in-methods';

/**
 * A NATIVE CLIENT'S PROVIDER TOKEN, CHECKED HERE (#444).
 *
 * The iOS app signs in with Google's or Facebook's own SDK and sends what the
 * SDK returns. That token is a claim made BY the client, so nothing in it is
 * believed until the provider's signature or the provider itself vouches for
 * it, AND it was minted for this app. A token minted for another app is a
 * real token about a real person; accepting it would let any app that person
 * signed into sign in here as them.
 *
 * - Google: an ID token (a JWT). Its signature against Google's published keys,
 *   `iss` Google, `aud` our iOS OAuth client (`GOOGLE_IOS_CLIENT_ID`, a
 *   different client from the web's).
 * - Facebook, classic login: a user access token, opaque. Graph's
 *   `debug_token`, asked with this app's credentials, says whether it is valid
 *   and which app it was issued to; then `/me` reads the person.
 * - Facebook, Limited Login (what the SDK returns when the person declined app
 *   tracking): an OIDC ID token, checked like Google's against Meta's keys,
 *   `aud` our Facebook app id.
 *
 * What comes back is the person as the provider states it. Whether that is
 * enough to sign in (an address, and a proved one) is the route's decision,
 * made by the same rules as the web's `signIn` callback.
 */

export type NativeProvider = 'google' | 'facebook';

export interface ProviderIdentity {
  provider: NativeProvider;
  /** Trimmed and lower-cased, or null when the provider gave none. */
  email: string | null;
  /**
   * Google: its `email_verified` was exactly `true`. Facebook sends no such
   * claim; a present address is taken as proved, the trust the web already
   * places in Meta (see `src/auth.ts`).
   */
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export type NativeGrantErrorCode =
  /** This deployment has no client id (or app secret) for the provider. */
  | 'SIGN_IN_METHOD_DISABLED'
  /** Forged, expired, for another app, or not a token at all. */
  | 'INVALID_PROVIDER_TOKEN'
  /** The provider could not be asked: its keys or Graph did not answer. */
  | 'PROVIDER_UNAVAILABLE';

export class NativeGrantError extends Error {
  constructor(
    readonly code: NativeGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeGrantError';
  }
}

/** Long enough for a provider's key set or Graph, short enough to fail fast. */
const PROVIDER_TIMEOUT_MS = 5000;

/** Seconds of clock difference a token's `exp`, `iat` and `nbf` may carry. */
const CLOCK_TOLERANCE_S = 30;

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** From https://limited.facebook.com/.well-known/openid-configuration/ */
const FACEBOOK_ISSUER = 'https://www.facebook.com';
const FACEBOOK_KEYS_URL = 'https://www.facebook.com/.well-known/oauth/openid/jwks/';

const DEBUG_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/debug_token`;
const ME_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`;

// One key set per provider for the process: jose caches the keys and refetches
// on an unknown `kid`, at most every 30 s.
const keySets = new Map<string, JWTVerifyGetKey>();
function remoteKeys(url: string): JWTVerifyGetKey {
  let keys = keySets.get(url);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url), { timeoutDuration: PROVIDER_TIMEOUT_MS });
    keySets.set(url, keys);
  }
  return keys;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const address = (v: unknown): string | null => text(v)?.toLowerCase() ?? null;

/**
 * A provider's ID token, verified, or a `NativeGrantError`. A token that is
 * wrong in any way is `INVALID_PROVIDER_TOKEN`; only a provider that did not
 * answer is `PROVIDER_UNAVAILABLE`, because that one is worth retrying.
 */
async function verifyIdToken(
  token: string,
  opts: { keys: JWTVerifyGetKey; issuer: string | string[]; audience: string | string[] },
) {
  try {
    const { payload } = await jwtVerify(token, opts.keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_S,
    });
    return payload;
  } catch (error) {
    if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) {
      throw new NativeGrantError('PROVIDER_UNAVAILABLE', 'The provider did not answer.');
    }
    // A key set that would not load is the provider's failure too; everything
    // else jose raises is about the token.
    if (error.code === 'ERR_JOSE_GENERIC' || error.code === 'ERR_JWKS_INVALID') {
      throw new NativeGrantError('PROVIDER_UNAVAILABLE', 'The provider did not answer.');
    }
    throw new NativeGrantError('INVALID_PROVIDER_TOKEN', 'The sign-in token is not valid.');
  }
}

export async function verifyGoogleIdToken(
  idToken: string,
  opts: { audiences?: string[]; keys?: JWTVerifyGetKey } = {},
): Promise<ProviderIdentity> {
  const audiences = opts.audiences ?? googleAppClientIds();
  if (audiences.length === 0) {
    throw new NativeGrantError(
      'SIGN_IN_METHOD_DISABLED',
      'Google sign-in from the app is not set up.',
    );
  }
  const claims = await verifyIdToken(idToken, {
    keys: opts.keys ?? remoteKeys(GOOGLE_KEYS_URL),
    issuer: GOOGLE_ISSUERS,
    audience: audiences,
  });
  return {
    provider: 'google',
    email: address(claims.email),
    // Exactly `true`, as the web requires: absent is not verified.
    emailVerified: claims.email_verified === true,
    name: text(claims.name),
    picture: text(claims.picture),
  };
}

export async function verifyFacebookIdToken(
  idToken: string,
  opts: { appId?: string; nonce?: string; keys?: JWTVerifyGetKey } = {},
): Promise<ProviderIdentity> {
  const appId = opts.appId ?? process.env.FACEBOOK_CLIENT_ID;
  if (!appId) {
    throw new NativeGrantError('SIGN_IN_METHOD_DISABLED', 'Facebook sign-in is not set up.');
  }
  const claims = await verifyIdToken(idToken, {
    keys: opts.keys ?? remoteKeys(FACEBOOK_KEYS_URL),
    issuer: FACEBOOK_ISSUER,
    audience: appId,
  });
  // The SDK puts the app's nonce in the token. When the app sends it along,
  // a token from some other sign-in does not match it.
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) {
    throw new NativeGrantError('INVALID_PROVIDER_TOKEN', 'The sign-in token is not valid.');
  }
  const email = address(claims.email);
  return {
    provider: 'facebook',
    email,
    emailVerified: email !== null,
    name: text(claims.name),
    picture: text(claims.picture),
  };
}

export async function verifyFacebookAccessToken(
  accessToken: string,
  opts: { appId?: string; appSecret?: string; fetch?: typeof fetch } = {},
): Promise<ProviderIdentity> {
  const appId = opts.appId ?? process.env.FACEBOOK_CLIENT_ID;
  const appSecret = opts.appSecret ?? process.env.FACEBOOK_CLIENT_SECRET;
  if (!appId || !appSecret) {
    throw new NativeGrantError('SIGN_IN_METHOD_DISABLED', 'Facebook sign-in is not set up.');
  }
  const fetchImpl = opts.fetch ?? fetch;

  const graph = async (url: URL, bearer: string): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${bearer}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      throw new NativeGrantError('PROVIDER_UNAVAILABLE', 'Facebook did not answer.');
    }
    if (res.status >= 500) {
      throw new NativeGrantError('PROVIDER_UNAVAILABLE', 'Facebook did not answer.');
    }
    // A 4xx from Graph is about the token: expired, revoked, malformed.
    if (!res.ok) {
      throw new NativeGrantError('INVALID_PROVIDER_TOKEN', 'The sign-in token is not valid.');
    }
    return res.json().catch(() => {
      throw new NativeGrantError('PROVIDER_UNAVAILABLE', 'Facebook did not answer.');
    });
  };

  // Asked with the app's own token, so Graph answers about OUR app. The
  // person's token is the subject, and Graph only takes it in the query.
  const debugUrl = new URL(DEBUG_TOKEN_URL);
  debugUrl.searchParams.set('input_token', accessToken);
  const debug = (
    (await graph(debugUrl, `${appId}|${appSecret}`)) as { data?: Record<string, unknown> }
  )?.data;
  if (
    !debug ||
    debug.is_valid !== true ||
    String(debug.app_id) !== appId ||
    (debug.type !== undefined && debug.type !== 'USER') ||
    !text(debug.user_id)
  ) {
    throw new NativeGrantError('INVALID_PROVIDER_TOKEN', 'The sign-in token is not valid.');
  }

  // The same fields the web reads, at the same pinned version. The proof is
  // what Graph asks of server calls when the app requires it.
  const meUrl = new URL(ME_URL);
  meUrl.searchParams.set('fields', FACEBOOK_USERINFO_FIELDS);
  meUrl.searchParams.set(
    'appsecret_proof',
    createHmac('sha256', appSecret).update(accessToken).digest('hex'),
  );
  const me = (await graph(meUrl, accessToken)) as Record<string, unknown> | null;
  // The person the token belongs to, not merely somebody.
  if (!me || String(me.id) !== String(debug.user_id)) {
    throw new NativeGrantError('INVALID_PROVIDER_TOKEN', 'The sign-in token is not valid.');
  }
  const email = address(me.email);
  return {
    provider: 'facebook',
    email,
    emailVerified: email !== null,
    name: text(me.name),
    // The web's reading: a silhouette is Facebook's "no picture".
    picture: facebookPictureFrom(me),
  };
}
