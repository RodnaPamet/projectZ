import type { Locale as DbLocale } from '@prisma/client';

import {
  buildGoogleCalendarAuthorizeUrl,
  exchangeGoogleCode,
  GOOGLE_CALENDAR_APP_SCOPE,
  GOOGLE_CALENDAR_CALLBACK_PATH,
  hashOAuthState,
  newOAuthState,
  revokeGoogleToken,
} from '@/lib/google-calendar/oauth';
import type { MyCalendarDto } from '@/app/api/v1/_lib/dto';
import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';
import { resolveLocale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { decryptField, encryptField } from '@/lib/security/encryption';

import {
  googleCalendarSyncOn,
  googleOAuthClient,
  readConnectionForSync,
  syncConnectionAsOwner,
  type CalendarSyncResult,
  type SyncDeps,
} from './google-calendar-sync';

/**
 * «Синхронизирай с Google Календар» (owner 2026-11-14): connecting a
 * player's own Google Calendar, reporting on it, and letting go of it.
 *
 * The consent flow is ported from agri-saas's connect route and callback
 * (#2005, #2495 step 6), per person instead of per farm, with ONE branch for
 * both clients: the `state` is always a server-held, single-use nonce, its
 * hash stored with who started it and where they return to. The phone needs
 * that (its consent sheet is ephemeral and carries no cookie), and the web is
 * simpler for sharing it, with one extra check: the web callback also carries
 * the session, and it must be the same person's.
 *
 * Off unless `GOOGLE_CALENDAR_SYNC=1` (and a Google client is configured):
 * every route answers 404 `GOOGLE_CALENDAR_SYNC_DISABLED`, which the app reads
 * as "hide the switch".
 */

export type CalendarClient = 'ios' | 'web';

/**
 * Where the phone is sent back to. A SERVER constant, never read from a
 * request: a client-supplied target would make the callback an open redirect.
 */
export const IOS_RETURN_URI = 'bg.playerz.app://integrations/google-calendar';

/** Where the web is sent back to: the profile, whose card reads `googleCalendar=`. */
export const WEB_RETURN_PATH = '/me/profile';

/**
 * The CLOSED set of `?error=` codes the callback returns. The phone treats
 * anything else as `internal_error`, so a value outside it is not a message.
 */
export const CONNECT_ERROR_CODES = [
  'access_denied',
  'insufficient_scope',
  'state_expired',
  'state_invalid',
  'token_exchange_failed',
  'feature_disabled',
  'internal_error',
] as const;
export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

/** Ten minutes: long enough to read a consent screen, too short to replay a logged state. */
export const STATE_TTL_SECONDS = 600;

export class GoogleCalendarSyncDisabledError extends Error {
  constructor() {
    super('Google Calendar sync is not switched on');
    this.name = 'GoogleCalendarSyncDisabledError';
  }
}

export class GoogleCalendarNotConnectedError extends Error {
  constructor() {
    super('No Google Calendar is connected');
    this.name = 'GoogleCalendarNotConnectedError';
  }
}

export class GoogleCalendarRevokedError extends Error {
  constructor() {
    super('Google no longer lets playerz write to this calendar. Connect it again.');
    this.name = 'GoogleCalendarRevokedError';
  }
}

export class GoogleCalendarUnavailableError extends Error {
  constructor() {
    super('Google Calendar did not answer. Try again in a little while.');
    this.name = 'GoogleCalendarUnavailableError';
  }
}

export function assertGoogleCalendarSyncOn(): void {
  if (!googleCalendarSyncOn()) throw new GoogleCalendarSyncDisabledError();
}

/** `${APP_URL}/api/integrations/google-calendar/callback`, the same at both ends. */
export function calendarRedirectUri(): string {
  const origin = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  return new URL(GOOGLE_CALENDAR_CALLBACK_PATH, origin).toString();
}

function appOrigin(): string {
  return process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
}

/** Start a consent: a state for this person and client, and Google's URL. */
export async function startGoogleCalendarConnect(input: {
  userId: string;
  client: CalendarClient;
  now?: Date;
}): Promise<{ authorizeUrl: string }> {
  assertGoogleCalendarSyncOn();
  const oauth = googleOAuthClient()!;
  const now = input.now ?? new Date();
  const state = newOAuthState();
  await runAsUserOnly(input.userId, (db) =>
    // guardrail-allow: cross-tenant — the person's own consent state.
    db.calendarOAuthState.create({
      data: {
        stateHash: state.hash,
        userId: input.userId,
        client: input.client,
        expiresAt: new Date(now.getTime() + STATE_TTL_SECONDS * 1000),
      },
    }),
  );
  return {
    authorizeUrl: buildGoogleCalendarAuthorizeUrl({
      clientId: oauth.clientId,
      redirectUri: calendarRedirectUri(),
      state: state.raw,
    }),
  };
}

type Claim =
  | { ok: true; userId: string; client: CalendarClient }
  | { ok: false; reason: 'state_expired' | 'state_invalid'; client: CalendarClient }
  | { ok: false; reason: 'unknown' };

/**
 * Claim a state exactly once: a conditional update on `consumedAt IS NULL`, so
 * two arrivals with one state cannot both pass (the second is the replay).
 * Superuser, because the callback learns WHO only by claiming; the hash of a
 * 32-byte secret the caller holds cannot enumerate anything.
 */
async function claimState(raw: string, now: Date): Promise<Claim> {
  const stateHash = hashOAuthState(raw);
  // guardrail-allow: cross-tenant — one state by the hash of its secret.
  return runAsSuperuser(async (db) => {
    const claimed = await db.calendarOAuthState.updateMany({
      where: { stateHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    const row = await db.calendarOAuthState.findUnique({
      where: { stateHash },
      select: { userId: true, client: true, expiresAt: true, consumedAt: true },
    });
    if (!row) return { ok: false, reason: 'unknown' };
    const client: CalendarClient = row.client === 'ios' ? 'ios' : 'web';
    if (claimed.count === 1) return { ok: true, userId: row.userId, client };
    return {
      ok: false,
      client,
      reason: row.consumedAt === null && row.expiresAt <= now ? 'state_expired' : 'state_invalid',
    };
  });
}

/** Where a finished consent sends the person, success or not. */
export function returnUrl(
  client: CalendarClient,
  outcome: { result: 'connected' } | { error: ConnectErrorCode },
): string {
  const q = 'result' in outcome ? `result=${outcome.result}` : `error=${outcome.error}`;
  if (client === 'ios') return `${IOS_RETURN_URI}?${q}`;
  const url = new URL(WEB_RETURN_PATH, appOrigin());
  url.searchParams.set('googleCalendar', 'result' in outcome ? outcome.result : outcome.error);
  return url.toString();
}

/**
 * The callback's work: claim the state, exchange the code, store the
 * connection, run the first sync. Answers the URL to redirect to; never
 * throws for anything a person or Google did.
 *
 * A first sync that fails does NOT fail the connect: the grant is good, and
 * the connection is left marked dirty for the five-minute loop.
 */
export async function completeGoogleCalendarConnect(
  input: {
    state: string | null;
    code: string | null;
    error: string | null;
    /** The signed-in user on this request, if any (the web carries one). */
    sessionUserId: string | null;
    locale?: string | null;
  },
  deps: SyncDeps = {},
): Promise<string> {
  const now = deps.now ?? new Date();
  if (!input.state) return returnUrl('web', { error: 'state_invalid' });

  const claim = await claimState(input.state, now);
  if (!claim.ok) {
    // An unknown state names no client; the web page is the honest default.
    return claim.reason === 'unknown'
      ? returnUrl('web', { error: 'state_invalid' })
      : returnUrl(claim.client, { error: claim.reason });
  }
  const fail = (error: ConnectErrorCode) => {
    logger.warn('google calendar connect refused', { component: 'google-calendar', reason: error });
    return returnUrl(claim.client, { error });
  };

  // After the claim: a declined consent still uses up its state.
  if (input.error)
    return fail(input.error === 'access_denied' ? 'access_denied' : 'internal_error');
  if (!googleCalendarSyncOn()) return fail('feature_disabled');
  if (!input.code) return fail('internal_error');
  // The web's request carries the session: it must be whoever started this.
  // (The phone's ephemeral sheet carries none; the state row is its proof.)
  if (claim.client === 'web' && input.sessionUserId !== claim.userId) {
    return fail('state_invalid');
  }

  let grant;
  try {
    grant = await exchangeGoogleCode(
      { code: input.code, redirectUri: calendarRedirectUri(), client: googleOAuthClient()! },
      deps.fetchImpl,
    );
  } catch (error) {
    logger.warn('google calendar code exchange failed', {
      component: 'google-calendar',
      error: (error as Error).message,
    });
    return fail('token_exchange_failed');
  }
  // Google's consent screen lets each scope be unticked. Without the
  // calendar there is nothing to sync; the grant is handed back.
  if (!grant.scopes.includes(GOOGLE_CALENDAR_APP_SCOPE)) {
    await revokeGoogleToken(grant.refreshToken, deps.fetchImpl);
    return fail('insufficient_scope');
  }

  const userId = claim.userId;
  const locale = await userLocale(userId, input.locale);
  const previous = await runAsUserOnly(userId, async (db) => {
    // guardrail-allow: cross-tenant — the person's own connection.
    const old = await db.googleCalendarConnection.findUnique({
      where: { userId },
      select: { refreshTokenEnc: true },
    });
    // guardrail-allow: cross-tenant — as above. A reconnect keeps the calendar id,
    // so the events already written are found again rather than duplicated.
    await db.googleCalendarConnection.upsert({
      where: { userId },
      create: {
        userId,
        refreshTokenEnc: encryptField(grant.refreshToken),
        googleEmail: grant.email,
        scopes: grant.scopes,
        locale,
        dirtyAt: now,
      },
      update: {
        refreshTokenEnc: encryptField(grant.refreshToken),
        googleEmail: grant.email,
        scopes: grant.scopes,
        status: 'ACTIVE',
        lastError: null,
        connectedAt: now,
        dirtyAt: now,
      },
    });
    return old?.refreshTokenEnc ?? null;
  });
  if (previous) {
    // The grant this one replaced, if Google issued a new refresh token.
    const old = decryptField(previous);
    if (old !== grant.refreshToken) await revokeGoogleToken(old, deps.fetchImpl);
  }

  const conn = await readConnectionForSync(userId);
  if (conn) await syncConnectionAsOwner(conn, deps);
  return returnUrl(claim.client, { result: 'connected' });
}

async function userLocale(userId: string, fallback?: string | null): Promise<DbLocale> {
  // guardrail-allow: cross-tenant — the person's own language.
  const user = await runAsSuperuser((db) =>
    db.user.findUnique({ where: { id: userId }, select: { locale: true } }),
  );
  return resolveLocale(user?.locale ?? fallback) as DbLocale;
}

export type MyCalendarStatus = MyCalendarDto;

/** `GET /api/v1/me/calendar`. A revoked connection reads `connected: false, error: GOOGLE_REVOKED`. */
export async function getMyCalendarStatus(userId: string): Promise<MyCalendarStatus> {
  assertGoogleCalendarSyncOn();
  const row = await runAsUserOnly(userId, (db) =>
    // guardrail-allow: cross-tenant — the person's own row.
    db.googleCalendarConnection.findUnique({
      where: { userId },
      select: {
        status: true,
        googleEmail: true,
        lastSyncAt: true,
        lastResultJson: true,
        lastError: true,
      },
    }),
  );
  if (!row) {
    return {
      google: { connected: false, email: null, lastSyncAt: null, lastResult: null, error: null },
    };
  }
  return {
    google: {
      connected: row.status === 'ACTIVE',
      email: row.googleEmail,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastResult: toResult(row.lastResultJson),
      error:
        row.status === 'REVOKED'
          ? 'GOOGLE_REVOKED'
          : row.lastError === 'GOOGLE_REVOKED' || row.lastError === 'GOOGLE_UNAVAILABLE'
            ? row.lastError
            : null,
    },
  };
}

function toResult(json: unknown): CalendarSyncResult | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const n = (k: string) => (typeof j[k] === 'number' ? (j[k] as number) : 0);
  return {
    created: n('created'),
    updated: n('updated'),
    deleted: n('deleted'),
    unchanged: n('unchanged'),
    skippedEdited: n('skippedEdited'),
    partial: j.partial === true,
  };
}

/** `POST /api/v1/me/calendar/google/sync`: now, as the person. */
export async function syncMyGoogleCalendar(
  userId: string,
  deps: SyncDeps = {},
): Promise<CalendarSyncResult> {
  assertGoogleCalendarSyncOn();
  const conn = await readConnectionForSync(userId);
  if (!conn) throw new GoogleCalendarNotConnectedError();
  if (conn.status === 'REVOKED') throw new GoogleCalendarRevokedError();
  const outcome = await syncConnectionAsOwner(conn, deps);
  if (outcome.ok) return outcome.result;
  if (outcome.code === 'GOOGLE_REVOKED') throw new GoogleCalendarRevokedError();
  throw new GoogleCalendarUnavailableError();
}

/**
 * `DELETE /api/v1/me/calendar/google`: the switch off. Revokes the grant at
 * Google and deletes the connection. Idempotent: nothing connected is fine.
 *
 * The «playerz» calendar and its events are LEFT in the person's Google
 * account, deliberately: they are in the person's account, and deleting them
 * would need the grant we are giving up. They stop being updated; the person
 * removes the calendar in Google in one gesture if they want it gone.
 */
export async function disconnectMyGoogleCalendar(
  userId: string,
  deps: Pick<SyncDeps, 'fetchImpl'> = {},
): Promise<void> {
  assertGoogleCalendarSyncOn();
  const token = await runAsUserOnly(userId, async (db) => {
    // guardrail-allow: cross-tenant — the person's own connection.
    const row = await db.googleCalendarConnection.findUnique({
      where: { userId },
      select: { refreshTokenEnc: true },
    });
    // guardrail-allow: cross-tenant — as above.
    await db.googleCalendarConnection.deleteMany({ where: { userId } });
    return row ? decryptField(row.refreshTokenEnc) : null;
  });
  if (token) await revokeGoogleCalendarGrant(token, deps.fetchImpl);
}

/**
 * The refresh token of a connection, read before an account is deleted so it
 * can be revoked once the deletion commits (the row goes with the account).
 */
export async function readGoogleCalendarGrant(userId: string): Promise<string | null> {
  const row = await runAsUserOnly(userId, (db) =>
    // guardrail-allow: cross-tenant — the person's own connection.
    db.googleCalendarConnection.findUnique({
      where: { userId },
      select: { refreshTokenEnc: true },
    }),
  );
  return row ? decryptField(row.refreshTokenEnc) : null;
}

/** Revoke at Google; logged, never thrown (what it follows has happened). */
export async function revokeGoogleCalendarGrant(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const ok = await revokeGoogleToken(token, fetchImpl);
  if (!ok) {
    logger.warn('google calendar grant not revoked at Google', { component: 'google-calendar' });
  }
  return ok;
}
