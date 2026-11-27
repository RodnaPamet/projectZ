import { createHash } from 'node:crypto';

import { GoogleGrantRevokedError, GoogleUnavailableError } from './oauth';

/**
 * The Google Calendar API surface for a player's sync (owner 2026-11-14),
 * ported from agri-saas `integrations/providers/google/calendar.ts`.
 *
 * ## A calendar of our own
 *
 * «playerz», made in the person's account and addressed by its stored id.
 * Their own calendar is never written into: a separate one can be hidden,
 * coloured or deleted in one gesture, and listing it is cheap because every
 * event in it is ours. Deleting it is a reset, not an error: the next sync
 * makes a new one.
 *
 * ## The mapping lives ON the event
 *
 * Each event carries our stable id (`booking:<id>`) and a fingerprint of what
 * we wrote, in `extendedProperties.private`. No table of event ids: the
 * mapping cannot drift from Google because it IS Google, and it goes when the
 * calendar goes.
 *
 * ## Timed events, in the club's zone
 *
 * Unlike agri-saas's all-day deadlines, a booking has a start and an end, so
 * each event is a `dateTime` pair with the venue's `timeZone`. The fingerprint
 * compares instants, not strings: Google answers `2026-11-20T18:00:00+02:00`
 * for what we sent as `…T16:00:00.000Z`.
 */

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Our id on an event. */
export const PLAYERZ_ID_PROPERTY = 'playerzId';
/** The fingerprint of what we last wrote, so a person's own edit is seen. */
export const PLAYERZ_HASH_PROPERTY = 'playerzHash';

/** At most this many pages of 250 when reading the calendar back. */
const MAX_PAGES = 20;

type Fetch = typeof fetch;

export interface EventContent {
  summary: string;
  /** ISO instants. */
  start: string;
  end: string;
  timeZone: string;
  location: string | null;
  description: string | null;
}

export interface ExistingEvent {
  eventId: string;
  playerzId: string;
  /** Null on an event without our fingerprint: treated as NOT edited. */
  writtenHash: string | null;
  /** The fingerprint of what the event says now. */
  currentHash: string;
  /** ISO instant of its start as Google has it now, for the window check. */
  start: string;
}

/**
 * A digest of the fields we own that a person is likely to change: the title
 * and the two instants. Not the place or the notes, which Google may
 * normalise and a person rarely touches; a change there is overwritten.
 *
 * NUL separator, written as the escape (agri-saas #2446: a raw NUL makes the
 * file binary to grep). It cannot occur in the inputs, so the digest is
 * unambiguous.
 */
export function contentFingerprint(c: { summary: string; start: string; end: string }): string {
  return createHash('sha256')
    .update(`${c.summary}\u0000${instant(c.start)}\u0000${instant(c.end)}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Any RFC 3339 form as one canonical ISO instant, to the SECOND; garbage
 * stays itself. Google keeps whole seconds and answers with an offset, so
 * `…T16:00:00.581Z` comes back as `…T18:00:00+02:00`: compared to the
 * millisecond, every event would read as edited by hand and be frozen.
 */
export function instant(value: string): string {
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(Math.floor(t / 1000) * 1000).toISOString();
}

/**
 * Has the person edited this event since we wrote it? Their edit wins, for an
 * update AND a delete: an event they changed is theirs now.
 */
export function wasEditedByUser(e: Pick<ExistingEvent, 'writtenHash' | 'currentHash'>): boolean {
  if (e.writtenHash === null) return false;
  return e.currentHash !== e.writtenHash;
}

/** The one place a Calendar status becomes our error. */
async function refuse(res: Response, what: string): Promise<never> {
  if (res.status === 401) throw new GoogleGrantRevokedError();
  if (res.status === 403) {
    // Read the reason: a 403 is a missing scope OR a rate limit, and telling
    // somebody to reconnect a working connection is the wrong advice.
    const detail = await res.text().catch(() => '');
    if (/insufficient/i.test(detail)) throw new GoogleGrantRevokedError();
  }
  throw new GoogleUnavailableError(`Google Calendar ${what} failed with ${res.status}`);
}

async function call(fetchImpl: Fetch, url: string, init: RequestInit, what: string) {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new GoogleUnavailableError(`Google Calendar ${what}: no answer`);
  }
}

function headers(accessToken: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

const cal = (calendarId: string) => `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`;

/**
 * The calendar we write into, made when the stored id names nothing (a first
 * sync, or the person deleted it: 404 or 410, an ordinary state).
 */
export async function ensureCalendar(
  accessToken: string,
  storedId: string | null,
  opts: { name: string; timeZone: string },
  fetchImpl: Fetch = fetch,
): Promise<{ calendarId: string; created: boolean }> {
  if (storedId) {
    const res = await call(fetchImpl, cal(storedId), { headers: headers(accessToken) }, 'lookup');
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as { id?: string } | null;
      if (json?.id) return { calendarId: json.id, created: false };
    } else if (res.status !== 404 && res.status !== 410) {
      await refuse(res, 'calendar lookup');
    }
  }
  const res = await call(
    fetchImpl,
    `${CALENDAR_API}/calendars`,
    {
      method: 'POST',
      headers: headers(accessToken, true),
      body: JSON.stringify({ summary: opts.name, timeZone: opts.timeZone }),
    },
    'create calendar',
  );
  if (!res.ok) await refuse(res, 'calendar create');
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  // Without an id we would have nowhere but the person's own calendar to
  // write to, which is exactly what a separate calendar avoids.
  if (!json?.id) throw new GoogleUnavailableError('Google made a calendar but returned no id');
  return { calendarId: json.id, created: true };
}

/**
 * Our events in the calendar whose time overlaps [from, to].
 *
 * `complete: false` when the page bound was hit: then the caller must neither
 * delete (an absence proves nothing) nor create (the event may be on a page we
 * did not read, and would be duplicated).
 */
export async function listEvents(
  accessToken: string,
  calendarId: string,
  window: { from: Date; to: Date },
  fetchImpl: Fetch = fetch,
): Promise<{ events: ExistingEvent[]; complete: boolean }> {
  const events: ExistingEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      maxResults: '250',
      showDeleted: 'false',
      singleEvents: 'true',
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
    });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await call(
      fetchImpl,
      `${cal(calendarId)}/events?${q.toString()}`,
      { headers: headers(accessToken) },
      'list',
    );
    if (!res.ok) await refuse(res, 'event list');
    const json = (await res.json().catch(() => null)) as {
      items?: Array<{
        id?: string;
        summary?: string;
        start?: { date?: string; dateTime?: string };
        end?: { date?: string; dateTime?: string };
        extendedProperties?: { private?: Record<string, string> };
      }>;
      nextPageToken?: string;
    } | null;
    for (const item of json?.items ?? []) {
      const priv = item.extendedProperties?.private ?? {};
      const playerzId = priv[PLAYERZ_ID_PROPERTY];
      // Not ours: the person may keep their own events in this calendar.
      if (!item.id || !playerzId) continue;
      const start = item.start?.dateTime ?? item.start?.date ?? '';
      const end = item.end?.dateTime ?? item.end?.date ?? '';
      events.push({
        eventId: item.id,
        playerzId,
        writtenHash: priv[PLAYERZ_HASH_PROPERTY] ?? null,
        currentHash: contentFingerprint({ summary: item.summary ?? '', start, end }),
        start: instant(start),
      });
    }
    pageToken = json?.nextPageToken;
    if (!pageToken) return { events, complete: true };
  }
  return { events, complete: false };
}

function eventBody(playerzId: string, c: EventContent) {
  return {
    summary: c.summary,
    ...(c.location ? { location: c.location } : {}),
    ...(c.description ? { description: c.description } : {}),
    start: { dateTime: instant(c.start), timeZone: c.timeZone },
    end: { dateTime: instant(c.end), timeZone: c.timeZone },
    extendedProperties: {
      private: {
        [PLAYERZ_ID_PROPERTY]: playerzId,
        [PLAYERZ_HASH_PROPERTY]: contentFingerprint(c),
      },
    },
  };
}

export async function createEvent(
  accessToken: string,
  calendarId: string,
  playerzId: string,
  content: EventContent,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const res = await call(
    fetchImpl,
    `${cal(calendarId)}/events`,
    {
      method: 'POST',
      headers: headers(accessToken, true),
      body: JSON.stringify(eventBody(playerzId, content)),
    },
    'create',
  );
  if (!res.ok) await refuse(res, 'event create');
}

/** PUT, not PATCH: the body is every field we own, the new fingerprint with it. */
export async function updateEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  playerzId: string,
  content: EventContent,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const res = await call(
    fetchImpl,
    `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PUT',
      headers: headers(accessToken, true),
      body: JSON.stringify(eventBody(playerzId, content)),
    },
    'update',
  );
  if (!res.ok) await refuse(res, 'event update');
}

/** A 404 or 410 is success: the person deleted it already. */
export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const res = await call(
    fetchImpl,
    `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: headers(accessToken) },
    'delete',
  );
  if (res.ok || res.status === 404 || res.status === 410) return;
  await refuse(res, 'event delete');
}

export interface BusyInterval {
  start: string;
  end: string;
}

/**
 * Busy intervals over [from, to] for some of the person's calendars, merged.
 *
 * `null` when Google could not compute one of them (a per-calendar `errors`
 * entry other than `notFound`, which is our deleted calendar): an incomplete
 * answer would read as "free" exactly where it is not.
 */
export async function queryFreeBusy(
  accessToken: string,
  calendarIds: string[],
  window: { from: Date; to: Date },
  fetchImpl: Fetch = fetch,
): Promise<BusyInterval[] | null> {
  const res = await call(
    fetchImpl,
    `${CALENDAR_API}/freeBusy`,
    {
      method: 'POST',
      headers: headers(accessToken, true),
      body: JSON.stringify({
        timeMin: window.from.toISOString(),
        timeMax: window.to.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      }),
    },
    'freeBusy',
  );
  if (!res.ok) await refuse(res, 'freeBusy');
  const json = (await res.json().catch(() => null)) as {
    calendars?: Record<
      string,
      { busy?: BusyInterval[]; errors?: Array<{ domain?: string; reason?: string }> }
    >;
  } | null;
  const busy: BusyInterval[] = [];
  for (const id of calendarIds) {
    const entry = json?.calendars?.[id];
    if (!entry) return null;
    if (entry.errors?.length) {
      if (entry.errors.every((e) => e.reason === 'notFound')) continue;
      return null;
    }
    for (const b of entry.busy ?? []) busy.push({ start: instant(b.start), end: instant(b.end) });
  }
  return mergeIntervals(busy);
}

/** Overlapping or touching intervals as one, in order. */
export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start));
  const out: BusyInterval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ ...i });
    }
  }
  return out;
}
