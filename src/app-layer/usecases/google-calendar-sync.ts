import type { Locale as DbLocale, PrismaClient } from '@prisma/client';

import {
  createEvent,
  deleteEvent,
  ensureCalendar,
  listEvents,
  queryFreeBusy,
  updateEvent,
  type BusyInterval,
  type EventContent,
} from '@/lib/google-calendar/api';
import {
  GoogleGrantRevokedError,
  GoogleUnavailableError,
  refreshGoogleAccessToken,
  type GoogleOAuthClient,
} from '@/lib/google-calendar/oauth';
import { planSync } from '@/lib/google-calendar/plan';
import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';
import { bookingHref } from '@/lib/notifications/booking-copy';
import { COACH_PROFILE_HREF } from '@/lib/coaches/hrefs';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * Keep a player's Google Calendar MATCHING their schedule (owner 2026-11-14).
 *
 * Ported from agri-saas `usecases/calendar-google-sync.ts` (#2020), per PERSON
 * where that one is per farm. The API surface is `src/lib/google-calendar/`;
 * the diff and its rules are `plan.ts` there. This is the orchestration: who
 * the person is, what their schedule is, and what the run recorded.
 *
 * ## A sync, not a push
 *
 * A booking moves (the desk), is cancelled (the player, the club, the sweep),
 * gains a player (an invite, an accepted request to join a game). A push would
 * leave the calendar planning around games that no longer exist. So: a
 * desired set is computed, the calendar is read back, and the difference is
 * applied. Cancelled → removed.
 *
 * ## What is on the calendar
 *
 * One event per booking the person plays on or teaches, CONFIRMED, COMPLETED
 * or marked NO_SHOW, starting inside the window:
 *
 *   - a court they booked, or were added to (an invite, the desk);
 *   - an open game they joined: an accepted request adds them to the booking;
 *   - a lesson, as the player, and as the coach who teaches it;
 *   - a tournament or league match placed on a court: its players are on its
 *     booking. A match with no court yet has no time, so no event.
 *
 * A PENDING booking is an unpaid hold or a league proposal not yet agreed,
 * which may never happen; it is left off until it is confirmed.
 *
 * ## Binding
 *
 * The connection is the person's row, read and written as them
 * (`runAsUserOnly`). Their schedule spans every club, and `booking` is
 * tenant-scoped, so it is read as `listMyBookings` reads it: superuser, keyed
 * on the person's id and nothing from the request. The five-minute loop is a
 * timer with nobody behind it, and reads every connection due.
 */

/** The calendar as it appears in the person's Google account. */
export const CALENDAR_NAME = 'playerz';

/**
 * Thirty days back keeps last week's games on the calendar; a year ahead is
 * further than anything a club takes bookings for. Both bound what a run
 * reads, and the window only ever NARROWS what may be deleted (see plan.ts).
 */
export const PAST_WINDOW_DAYS = 30;
export const FUTURE_WINDOW_DAYS = 365;

/** At most this many bookings per run; more and the run is `partial`. */
export const SCHEDULE_CAP = 1000;

/** The calendar's own zone; each event also carries its venue's. */
const DEFAULT_TIME_ZONE = 'Europe/Sofia';

export interface CalendarSyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Left alone because the person had edited them. */
  skippedEdited: number;
  /** Something was held back: see plan.ts. */
  partial: boolean;
}

/** The closed set a failed sync records, and `GET /me/calendar` reports. */
export type CalendarSyncErrorCode = 'GOOGLE_REVOKED' | 'GOOGLE_UNAVAILABLE';

export interface SyncDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
}

export interface ConnectionForSync {
  id: string;
  userId: string;
  refreshTokenEnc: string;
  calendarId: string | null;
  locale: DbLocale;
  dirtyAt: Date | null;
}

export function syncWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - PAST_WINDOW_DAYS * 86_400_000),
    to: new Date(now.getTime() + FUTURE_WINDOW_DAYS * 86_400_000),
  };
}

/** The OAuth client, or null when the deployment has none. */
export function googleOAuthClient(): GoogleOAuthClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** `GOOGLE_CALENDAR_SYNC=1` and a Google client to do it with. */
export function googleCalendarSyncOn(): boolean {
  return process.env.GOOGLE_CALENDAR_SYNC === '1' && googleOAuthClient() !== null;
}

type Kind = 'booking' | 'game' | 'lesson' | 'lessonTaught' | 'tournament';

/**
 * The person's schedule in the window, as event content keyed by our id.
 *
 * Titles are written in the connection's own language, fixed at connect, for
 * agri-saas's reason: resolved per run from whoever is asking, two languages
 * would rewrite every title back and forth.
 */
export async function readSchedule(
  userId: string,
  locale: DbLocale,
  window: { from: Date; to: Date },
): Promise<{ desired: Map<string, EventContent>; truncated: boolean }> {
  // guardrail-allow: cross-tenant — the person's own schedule spans every club;
  // keyed on their id, never on the request.
  const rows = await runAsSuperuser((db) =>
    db.booking.findMany({
      where: {
        status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] },
        startTs: { gte: window.from, lte: window.to },
        OR: [
          { bookedByUserId: userId },
          { participants: { some: { userId } } },
          { lesson: { coachUserId: userId } },
        ],
      },
      orderBy: [{ startTs: 'asc' }, { id: 'asc' }],
      take: SCHEDULE_CAP + 1,
      select: {
        id: true,
        startTs: true,
        endTs: true,
        resource: {
          select: {
            name: true,
            venue: { select: { name: true, addressLine: true, city: true, timezone: true } },
          },
        },
        openGame: { select: { id: true } },
        lesson: { select: { coachUserId: true } },
        tournamentMatch: { select: { tournament: { select: { name: true } } } },
      },
    }),
  );

  const truncated = rows.length > SCHEDULE_CAP;
  const desired = new Map<string, EventContent>();
  for (const b of rows.slice(0, SCHEDULE_CAP)) {
    const venue = b.resource.venue;
    const kind: Kind = b.lesson
      ? b.lesson.coachUserId === userId
        ? 'lessonTaught'
        : 'lesson'
      : b.tournamentMatch
        ? 'tournament'
        : b.openGame
          ? 'game'
          : 'booking';
    const summary = await translateFor(locale, `calendarSync.event.${kind}`, {
      venue: venue.name,
      tournament: b.tournamentMatch?.tournament.name ?? '',
    });
    const link = absoluteUrl(kind === 'lessonTaught' ? COACH_PROFILE_HREF : bookingHref(b.id));
    desired.set(`booking:${b.id}`, {
      summary,
      start: b.startTs.toISOString(),
      end: b.endTs.toISOString(),
      timeZone: venue.timezone || DEFAULT_TIME_ZONE,
      location: [venue.name, venue.addressLine, venue.city].filter(Boolean).join(', '),
      description: `${b.resource.name}\n${link}`,
    });
  }
  return { desired, truncated };
}

/**
 * One sync of one connection: the token, the calendar, the schedule, the diff.
 *
 * Throws `GoogleGrantRevokedError` or `GoogleUnavailableError`; the callers
 * record which (`runSync`). Idempotent and safe unattended: it never deletes
 * on an incomplete read and never touches an event the person edited.
 */
async function syncOnce(
  conn: ConnectionForSync,
  client: GoogleOAuthClient,
  deps: SyncDeps,
): Promise<{ result: CalendarSyncResult; calendarId: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  const accessToken = await refreshGoogleAccessToken(
    decryptField(conn.refreshTokenEnc),
    client,
    fetchImpl,
  );
  const calendar = await ensureCalendar(
    accessToken,
    conn.calendarId,
    { name: CALENDAR_NAME, timeZone: DEFAULT_TIME_ZONE },
    fetchImpl,
  );
  const window = syncWindow(now);
  const schedule = await readSchedule(conn.userId, conn.locale, window);
  const listed = await listEvents(accessToken, calendar.calendarId, window, fetchImpl);
  const plan = planSync({
    desired: schedule.desired,
    existing: listed.events,
    window,
    scheduleTruncated: schedule.truncated,
    calendarComplete: listed.complete,
  });

  for (const id of plan.remove) {
    await deleteEvent(accessToken, calendar.calendarId, id, fetchImpl);
  }
  for (const u of plan.update) {
    await updateEvent(
      accessToken,
      calendar.calendarId,
      u.eventId,
      u.playerzId,
      u.content,
      fetchImpl,
    );
  }
  for (const c of plan.create) {
    await createEvent(accessToken, calendar.calendarId, c.playerzId, c.content, fetchImpl);
  }

  return {
    calendarId: calendar.calendarId,
    result: {
      created: plan.create.length,
      updated: plan.update.length,
      deleted: plan.remove.length,
      unchanged: plan.unchanged,
      skippedEdited: plan.skippedEdited,
      partial: plan.partial,
    },
  };
}

export type SyncOutcome =
  { ok: true; result: CalendarSyncResult } | { ok: false; code: CalendarSyncErrorCode };

/**
 * Sync and record the outcome on the connection, through `write` (bound as the
 * person, or as the loop). The dirty mark is cleared only if it still holds
 * the value read before the schedule was: a change committed during the run
 * left a newer one, which the next run picks up (P88).
 */
export async function runSync(
  conn: ConnectionForSync,
  write: <T>(fn: (db: PrismaClient) => Promise<T>) => Promise<T>,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  const client = googleOAuthClient();
  if (!client) return { ok: false, code: 'GOOGLE_UNAVAILABLE' };
  const now = deps.now ?? new Date();

  let outcome: SyncOutcome;
  let calendarId = conn.calendarId;
  try {
    const done = await syncOnce(conn, client, deps);
    calendarId = done.calendarId;
    outcome = { ok: true, result: done.result };
  } catch (error) {
    if (error instanceof GoogleGrantRevokedError) outcome = { ok: false, code: 'GOOGLE_REVOKED' };
    else if (error instanceof GoogleUnavailableError) {
      outcome = { ok: false, code: 'GOOGLE_UNAVAILABLE' };
    } else throw error;
    logger.warn('google calendar sync failed', {
      component: 'google-calendar',
      code: outcome.code,
      error: (error as Error).message,
    });
  }

  await write(async (db) => {
    // guardrail-allow: cross-tenant — one person's connection, by its id.
    await db.googleCalendarConnection.updateMany({
      where: { id: conn.id },
      data: outcome.ok
        ? {
            calendarId,
            lastSyncAt: now,
            lastResultJson: outcome.result as never,
            lastError: null,
          }
        : {
            calendarId,
            lastError: outcome.code,
            // Revoked is the person's to fix («Свържете отново»); the loop
            // stops trying until they reconnect.
            ...(outcome.code === 'GOOGLE_REVOKED' ? { status: 'REVOKED' as const } : {}),
          },
    });
    if (outcome.ok) {
      // guardrail-allow: cross-tenant — as above; compare-and-clear (P88).
      await db.googleCalendarConnection.updateMany({
        where: { id: conn.id, dirtyAt: conn.dirtyAt },
        data: { dirtyAt: null },
      });
    }
  });
  return outcome;
}

const SYNC_SELECT = {
  id: true,
  userId: true,
  refreshTokenEnc: true,
  calendarId: true,
  locale: true,
  dirtyAt: true,
} as const;

/** The person's own connection, as the sync needs it; null when there is none. */
export async function readConnectionForSync(
  userId: string,
): Promise<(ConnectionForSync & { status: 'ACTIVE' | 'REVOKED' }) | null> {
  return runAsUserOnly(userId, (db) =>
    // guardrail-allow: cross-tenant — the person's own row, by their session id.
    db.googleCalendarConnection.findUnique({
      where: { userId },
      select: { ...SYNC_SELECT, status: true },
    }),
  );
}

/** Sync the caller's own calendar now, recording the outcome as them. */
export async function syncConnectionAsOwner(
  conn: ConnectionForSync,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  return runSync(conn, (fn) => runAsUserOnly(conn.userId, fn), deps);
}

/** How often a connection is synced in full even when nothing marked it. */
export const FULL_RESYNC_HOURS = 6;
/** Per loop run: a bound, so a backlog drains over several runs. */
export const DUE_BATCH = 50;

/**
 * The five-minute loop (`POST /api/cron/sync-calendars`): every ACTIVE
 * connection marked dirty, then every one not synced for six hours (which
 * also catches an event a person deleted by hand, and a venue that changed
 * its address). Dirty first, oldest mark first. Sequential, so one person's
 * slow Google cannot fan out into fifty open requests.
 *
 * Also drops consent states that expired a day ago (P88).
 */
export async function syncDueCalendars(deps: SyncDeps = {}): Promise<{
  synced: number;
  failed: number;
  revoked: number;
  states: number;
}> {
  if (!googleCalendarSyncOn()) return { synced: 0, failed: 0, revoked: 0, states: 0 };
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - FULL_RESYNC_HOURS * 3_600_000);

  const due = await runAsSuperuser(async (db) => {
    // guardrail-allow: cross-tenant — the loop is a timer: every connection due, by state alone.
    const dirty = await db.googleCalendarConnection.findMany({
      where: { status: 'ACTIVE', dirtyAt: { not: null } },
      select: SYNC_SELECT,
      orderBy: { dirtyAt: 'asc' },
      take: DUE_BATCH,
    });
    const room = DUE_BATCH - dirty.length;
    const stale =
      room > 0
        ? // guardrail-allow: cross-tenant — as above: the ones not synced for six hours.
          await db.googleCalendarConnection.findMany({
            where: {
              status: 'ACTIVE',
              dirtyAt: null,
              OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: staleBefore } }],
            },
            select: SYNC_SELECT,
            orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } },
            take: room,
          })
        : [];
    return [...dirty, ...stale];
  });

  let synced = 0;
  let failed = 0;
  let revoked = 0;
  for (const conn of due) {
    // guardrail-allow: n-plus-one — one Google round trip per person, by design.
    const outcome = await runSync(conn, (fn) => runAsSuperuser(fn), { ...deps, now });
    if (outcome.ok) synced++;
    else if (outcome.code === 'GOOGLE_REVOKED') revoked++;
    else failed++;
  }

  // guardrail-allow: cross-tenant — expired consent states, by age alone.
  const states = await runAsSuperuser(
    async (db) =>
      (
        await db.calendarOAuthState.deleteMany({
          where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
        })
      ).count,
  );
  return { synced, failed, revoked, states };
}

// ─── Busy or free, for the assistant ──────────────────────────────────────

export type FreeBusyAnswer =
  | { known: true; busy: BusyInterval[] }
  | {
      known: false;
      /** Never guessed: unknown is not free. */
      reason: 'not_connected' | 'revoked' | 'unavailable' | 'disabled';
    };

/** Google answers free/busy over a bounded range; a week of planning needs far less. */
export const FREEBUSY_MAX_DAYS = 60;
export const FREEBUSY_MAX_USERS = 20;

/**
 * When each of these people is busy between `from` and `to`, from their own
 * Google calendars: their primary calendar and the «playerz» one. For the
 * assistant that will propose a time for a game from its confirmed players'
 * calendars (owner 2026-11-14); nothing calls it yet. Only busy intervals
 * come back from Google (`calendar.freebusy`): no titles, places or people.
 *
 * A person with no connection, a revoked one, or one Google could not answer
 * for is `known: false`, never an empty (free) list. The caller decides who
 * may ask about whom; this reads any listed person's connection, so it must
 * only be handed the players of a game the asker is on.
 */
export async function freeBusyFor(
  userIds: readonly string[],
  from: Date,
  to: Date,
  deps: SyncDeps = {},
): Promise<Record<string, FreeBusyAnswer>> {
  if (!(to > from)) throw new RangeError('freeBusyFor: `to` must be after `from`');
  if (to.getTime() - from.getTime() > FREEBUSY_MAX_DAYS * 86_400_000) {
    throw new RangeError(`freeBusyFor: at most ${FREEBUSY_MAX_DAYS} days`);
  }
  const ids = [...new Set(userIds)];
  if (ids.length > FREEBUSY_MAX_USERS) {
    throw new RangeError(`freeBusyFor: at most ${FREEBUSY_MAX_USERS} people`);
  }

  const out: Record<string, FreeBusyAnswer> = {};
  const client = googleOAuthClient();
  if (!googleCalendarSyncOn() || !client) {
    for (const id of ids) out[id] = { known: false, reason: 'disabled' };
    return out;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;

  const rows = ids.length
    ? await runAsSuperuser((db) =>
        // guardrail-allow: cross-tenant — the connections of the people the caller
        // named (a game's players), by their ids; only the token and calendar id.
        db.googleCalendarConnection.findMany({
          where: { userId: { in: ids } },
          select: { id: true, userId: true, refreshTokenEnc: true, calendarId: true, status: true },
          take: ids.length,
        }),
      )
    : [];
  const byUser = new Map(rows.map((r) => [r.userId, r]));

  for (const id of ids) {
    const conn = byUser.get(id);
    if (!conn) {
      out[id] = { known: false, reason: 'not_connected' };
      continue;
    }
    if (conn.status !== 'ACTIVE') {
      out[id] = { known: false, reason: 'revoked' };
      continue;
    }
    try {
      // guardrail-allow: n-plus-one — one Google round trip per person, by design.
      const token = await refreshGoogleAccessToken(
        decryptField(conn.refreshTokenEnc),
        client,
        fetchImpl,
      );
      const calendars = ['primary', ...(conn.calendarId ? [conn.calendarId] : [])];
      const busy = await queryFreeBusy(token, calendars, { from, to }, fetchImpl);
      out[id] = busy ? { known: true, busy } : { known: false, reason: 'unavailable' };
    } catch (error) {
      if (error instanceof GoogleGrantRevokedError) {
        // guardrail-allow: cross-tenant — that one connection, by its id.
        await runAsSuperuser((db) =>
          db.googleCalendarConnection.updateMany({
            where: { id: conn.id },
            data: { status: 'REVOKED', lastError: 'GOOGLE_REVOKED' },
          }),
        );
        out[id] = { known: false, reason: 'revoked' };
      } else if (error instanceof GoogleUnavailableError) {
        out[id] = { known: false, reason: 'unavailable' };
      } else {
        throw error;
      }
    }
  }
  return out;
}
