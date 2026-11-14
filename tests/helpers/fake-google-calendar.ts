/**
 * A fake of the parts of Google the calendar sync calls (owner 2026-11-14):
 * the OAuth token and revoke endpoints, calendars, events and freeBusy. In
 * memory, as a `fetch`, so no test ever reaches Google.
 *
 * It answers the way Google does where the sync depends on it: `dateTime`
 * comes back with an offset rather than as UTC, a deleted calendar is a 404,
 * a dead refresh token is a 400 `invalid_grant`.
 */

export interface FakeEvent {
  id: string;
  summary: string;
  location?: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

const SCOPES =
  'openid email https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.freebusy';

/** `2026-11-20T16:00:00.000Z` → `2026-11-20T18:00:00+02:00`, as Google writes it back. */
function withOffset(iso: string): string {
  const t = new Date(iso).getTime() + 2 * 3_600_000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '+02:00');
}

function idToken(email: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ email, sub: 'g-1' })}.sig`;
}

export class FakeGoogle {
  calendars = new Map<string, { summary: string; events: Map<string, FakeEvent> }>();
  /** Refresh tokens Google still honours. */
  liveRefreshTokens = new Set<string>();
  revoked: string[] = [];
  /** Granted scopes for the next code exchange. */
  grantScopes = SCOPES;
  email = 'player@gmail.test';
  busy: Record<string, Array<{ start: string; end: string }>> = {};
  /** Answer every Calendar call with this status, when set. */
  calendarStatus: number | null = null;
  calls: Array<{ method: string; url: string }> = [];
  private n = 0;

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push({ method, url: url.toString() });
    const json = (status: number, body: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') === 'bad-code') return json(400, { error: 'invalid_grant' });
        const refresh = `rt-${++this.n}`;
        this.liveRefreshTokens.add(refresh);
        return json(200, {
          access_token: `at-${refresh}`,
          refresh_token: refresh,
          expires_in: 3599,
          scope: this.grantScopes,
          id_token: idToken(this.email),
        });
      }
      const refresh = form.get('refresh_token') ?? '';
      if (!this.liveRefreshTokens.has(refresh)) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: `at-${refresh}`, expires_in: 3599 });
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      const token = new URLSearchParams(String(init.body)).get('token') ?? '';
      this.revoked.push(token);
      this.liveRefreshTokens.delete(token);
      return json(200, {});
    }

    if (url.host !== 'www.googleapis.com') throw new Error(`unexpected fetch ${url}`);
    const auth = new Headers(init.headers).get('authorization') ?? '';
    const refresh = auth.replace(/^Bearer at-/, '');
    if (!this.liveRefreshTokens.has(refresh)) return json(401, { error: 'unauthorized' });
    if (this.calendarStatus) return json(this.calendarStatus, { error: 'nope' });

    const path = url.pathname.replace('/calendar/v3', '');
    if (path === '/freeBusy' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { items: Array<{ id: string }> };
      const calendars: Record<string, unknown> = {};
      for (const { id } of body.items) {
        calendars[id] =
          id === 'primary' || this.calendars.has(id)
            ? { busy: this.busy[id] ?? [] }
            : { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
      }
      return json(200, { kind: 'calendar#freeBusy', calendars });
    }
    if (path === '/calendars' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { summary: string };
      const id = `cal-${++this.n}@group.calendar.google.com`;
      this.calendars.set(id, { summary: body.summary, events: new Map() });
      return json(200, { id, summary: body.summary });
    }
    const m = /^\/calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(path);
    if (!m) throw new Error(`unexpected Calendar call ${method} ${path}`);
    const calId = decodeURIComponent(m[1]!);
    const cal = this.calendars.get(calId);
    if (!cal) return json(404, { error: 'notFound' });
    const isEvents = path.includes('/events');
    const eventId = m[2] ? decodeURIComponent(m[2]) : null;

    if (!isEvents && method === 'GET') return json(200, { id: calId, summary: cal.summary });
    if (isEvents && !eventId && method === 'GET') {
      const from = Date.parse(url.searchParams.get('timeMin') ?? '1970-01-01T00:00:00Z');
      const to = Date.parse(url.searchParams.get('timeMax') ?? '2999-01-01T00:00:00Z');
      const items = [...cal.events.values()].filter(
        (e) => Date.parse(e.end.dateTime) > from && Date.parse(e.start.dateTime) < to,
      );
      return json(200, { items });
    }
    if (isEvents && !eventId && method === 'POST') {
      const body = JSON.parse(String(init.body)) as FakeEvent;
      const id = `ev${++this.n}`;
      cal.events.set(id, this.stored(id, body));
      return json(200, { id });
    }
    if (eventId && method === 'PUT') {
      if (!cal.events.has(eventId)) return json(404, { error: 'notFound' });
      cal.events.set(eventId, this.stored(eventId, JSON.parse(String(init.body)) as FakeEvent));
      return json(200, { id: eventId });
    }
    if (eventId && method === 'DELETE') {
      if (!cal.events.delete(eventId)) return json(410, { error: 'deleted' });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected Calendar call ${method} ${path}`);
  }) as typeof fetch;

  private stored(id: string, body: FakeEvent): FakeEvent {
    return {
      ...body,
      id,
      start: { ...body.start, dateTime: withOffset(body.start.dateTime) },
      end: { ...body.end, dateTime: withOffset(body.end.dateTime) },
    };
  }

  /** Every event in every calendar. */
  events(): FakeEvent[] {
    return [...this.calendars.values()].flatMap((c) => [...c.events.values()]);
  }

  /** A person editing an event's title in Google. */
  editTitle(eventId: string, summary: string): void {
    for (const c of this.calendars.values()) {
      const e = c.events.get(eventId);
      if (e) c.events.set(eventId, { ...e, summary });
    }
  }

  /** The person removes playerz from their Google account. */
  revokeAll(): void {
    this.liveRefreshTokens.clear();
  }
}
