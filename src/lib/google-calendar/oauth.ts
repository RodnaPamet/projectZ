import { createHash, randomBytes } from 'node:crypto';

/**
 * Google's OAuth for a player's calendar (owner 2026-11-14), ported from
 * agri-saas `integrations/providers/google/token.ts`, per PERSON instead of
 * per farm.
 *
 * A SEPARATE grant from sign-in. `src/auth.ts` asks Google for `openid email
 * profile` and nothing else, so the sign-in token cannot touch a calendar; and
 * this one belongs to the person's calendar connection, not to a session, so
 * disconnecting it does not sign anybody out. The same web OAuth client
 * (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), with its own redirect URI.
 *
 * Everything takes `fetchImpl`, so the token math is tested without a network.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/**
 * Make the «playerz» calendar, and create, change and delete events IN IT.
 *
 * NOT `calendar.events`, which was the first plan and cannot do the job:
 * `calendars.insert` and `calendars.get` accept only `calendar`,
 * `calendar.app.created` or `calendar.calendars` (Google's reference, checked
 * 2026-11-14), so a grant of `calendar.events` would fail its first sync with
 * a 403 while making the dedicated calendar. It is also the wider of the two:
 * `calendar.events` reaches every event in every calendar the person has,
 * `calendar.app.created` only the calendars playerz made. Owner agreed
 * 2026-11-14.
 */
export const GOOGLE_CALENDAR_APP_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

/**
 * Busy or free, and nothing else: no titles, places or people (owner
 * 2026-11-14). For the assistant that proposes a time when every player on a
 * game is free (`freeBusyFor`).
 */
export const GOOGLE_CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';

/**
 * THE scopes, the one list. `openid email` only so the ID token names the
 * Google account («Свързан като …»); no Drive, no contacts, nothing else.
 */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [
  'openid',
  'email',
  GOOGLE_CALENDAR_APP_SCOPE,
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
];

/** The callback, under the app's origin. One for the phone and the web. */
export const GOOGLE_CALENDAR_CALLBACK_PATH = '/api/integrations/google-calendar/callback';

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The grant as Google answered it: only what is kept, and what the sync needs now. */
export interface GoogleGrant {
  refreshToken: string;
  accessToken: string;
  /** What Google actually granted; a person may untick a scope on the consent screen. */
  scopes: string[];
  /** The Google account's address, from the ID token; null if none came. */
  email: string | null;
}

/** Google said the grant is gone: `invalid_grant` on refresh, or a 401 on a fresh token. */
export class GoogleGrantRevokedError extends Error {
  constructor() {
    super('The Google grant was revoked or has expired');
    this.name = 'GoogleGrantRevokedError';
  }
}

/** Google could not be reached, or answered with an error that is not the grant's. */
export class GoogleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleUnavailableError';
  }
}

/**
 * The consent URL.
 *
 * `access_type=offline` + `prompt=consent`: Google sends a refresh token on a
 * person's first consent only, and on later ones ONLY when consent is forced.
 * Without it a reconnect would work for an hour and then stop for good.
 *
 * `include_granted_scopes=true`: incremental authorisation. The grant this
 * returns covers what the person already gave this client (sign-in's `openid
 * email profile`) as well, rather than a token that silently narrows it.
 */
export function buildGoogleCalendarAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    state: opts.state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** A fresh state: 32 random bytes for the URL, and the hash the server keeps. */
export function newOAuthState(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashOAuthState(raw) };
}

export function hashOAuthState(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * The `email` claim of an ID token, without checking its signature.
 *
 * Allowed here and nowhere else: the token came straight from Google's token
 * endpoint over TLS, in answer to our own client secret (OpenID Connect Core
 * 3.1.3.7), and it is used for a label on the settings card, never to decide
 * who anybody is.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null;
  } catch {
    return null;
  }
}

/** The first grant, for the code the callback received. */
export async function exchangeGoogleCode(
  opts: { code: string; redirectUri: string; client: GoogleOAuthClient },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleGrant> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.client.clientId,
        client_secret: opts.client.clientSecret,
        grant_type: 'authorization_code',
        code: opts.code,
        redirect_uri: opts.redirectUri,
      }),
    });
  } catch {
    throw new GoogleUnavailableError('Google token endpoint unreachable');
  }
  if (!res.ok) throw new GoogleUnavailableError(`Google code exchange failed: ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
  } | null;
  if (!data?.access_token || !data.refresh_token) {
    // A grant with no refresh token works for an hour and then stops with no
    // way back. Refusing it now beats a connection that dies tonight.
    throw new GoogleUnavailableError('Google returned no refresh token');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
    email: emailFromIdToken(data.id_token),
  };
}

/**
 * A fresh access token for a stored refresh token.
 *
 * Asked for on every sync rather than stored: one call an hour at most per
 * person, and one fewer secret at rest. Google does not rotate the refresh
 * token on refresh, so there is nothing to write back.
 */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  client: GoogleOAuthClient,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
  } catch {
    throw new GoogleUnavailableError('Google token endpoint unreachable');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    // `invalid_grant` is the person removing playerz from their Google
    // account, a password change on some account types, or a grant unused for
    // six months. Every other refusal is ours or Google's, not theirs.
    if (res.status === 400 && body?.error === 'invalid_grant') throw new GoogleGrantRevokedError();
    throw new GoogleUnavailableError(`Google refresh failed: ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!data?.access_token) throw new GoogleUnavailableError('Google refresh returned no token');
  return data.access_token;
}

/**
 * Revoke a grant at Google. Best effort: true when Google confirmed it, or
 * said the token was already dead (400). Never throws, because it runs after
 * a disconnect or a deletion that has already happened.
 *
 * Revoking ends the WHOLE grant this client holds for the person, sign-in's
 * `openid email profile` included: their next Google sign-in shows the consent
 * screen once more. It still signs them in.
 */
export async function revokeGoogleToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}
