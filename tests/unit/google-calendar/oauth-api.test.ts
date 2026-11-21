/**
 * @jest-environment node
 */
import { listEvents, mergeIntervals, queryFreeBusy } from '@/lib/google-calendar/api';
import {
  buildGoogleCalendarAuthorizeUrl,
  emailFromIdToken,
  exchangeGoogleCode,
  GOOGLE_CALENDAR_SCOPES,
  GoogleGrantRevokedError,
  GoogleUnavailableError,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from '@/lib/google-calendar/oauth';

import { FakeGoogle } from '../../helpers/fake-google-calendar';

/** Google's OAuth and Calendar calls for the sync (owner 2026-11-14), against a fake. */

const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' };

describe('the consent URL', () => {
  const url = new URL(
    buildGoogleCalendarAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: 'https://playerz.bg/api/integrations/google-calendar/callback',
      state: 'abc',
    }),
  );

  it('asks for exactly the calendar it makes and busy/free, and nothing else', () => {
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ]);
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain('https://www.googleapis.com/auth/calendar');
    expect(url.searchParams.get('scope')).not.toMatch(/drive|calendar\.events|contacts/);
  });

  it('forces a refresh token and keeps earlier grants', () => {
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('state')).toBe('abc');
  });
});

describe('tokens', () => {
  it('exchanges a code for a refresh token, the granted scopes and the address', async () => {
    const g = new FakeGoogle();
    const grant = await exchangeGoogleCode({ code: 'c', redirectUri: 'r', client }, g.fetch);
    expect(grant.refreshToken).toMatch(/^rt-/);
    expect(grant.scopes).toContain('https://www.googleapis.com/auth/calendar.app.created');
    expect(grant.email).toBe('player@gmail.test');
  });

  it('a refused code is Google unavailable to us, not a crash', async () => {
    const g = new FakeGoogle();
    await expect(
      exchangeGoogleCode({ code: 'bad-code', redirectUri: 'r', client }, g.fetch),
    ).rejects.toBeInstanceOf(GoogleUnavailableError);
  });

  it('invalid_grant on refresh means the grant is gone', async () => {
    const g = new FakeGoogle();
    await expect(refreshGoogleAccessToken('rt-dead', client, g.fetch)).rejects.toBeInstanceOf(
      GoogleGrantRevokedError,
    );
  });

  it('a 500 on refresh is not a revocation', async () => {
    const failing = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    await expect(refreshGoogleAccessToken('rt', client, failing)).rejects.toBeInstanceOf(
      GoogleUnavailableError,
    );
  });

  it('revoking never throws, and reports a network failure', async () => {
    const g = new FakeGoogle();
    expect(await revokeGoogleToken('rt-1', g.fetch)).toBe(true);
    expect(g.revoked).toEqual(['rt-1']);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await revokeGoogleToken('rt-1', down)).toBe(false);
  });

  it('reads the address from an ID token, and nothing from garbage', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'a@b.test' })).toString('base64url');
    expect(emailFromIdToken(`h.${payload}.s`)).toBe('a@b.test');
    expect(emailFromIdToken('nope')).toBeNull();
    expect(emailFromIdToken(undefined)).toBeNull();
  });
});

describe('the calendar read back', () => {
  it('keeps only our events, and says when it stopped at the page bound', async () => {
    let page = 0;
    const paged = (async () => {
      page++;
      return new Response(
        JSON.stringify({
          items: [
            {
              id: `e${page}`,
              summary: 'x',
              start: { dateTime: '2026-11-20T18:00:00+02:00' },
              end: { dateTime: '2026-11-20T19:00:00+02:00' },
              extendedProperties: { private: { playerzId: `booking:${page}` } },
            },
            {
              id: `mine${page}`,
              summary: 'their own',
              start: { dateTime: '2026-11-20T18:00:00+02:00' },
              end: { dateTime: '2026-11-20T19:00:00+02:00' },
            },
          ],
          nextPageToken: 'more',
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2027-10-01T00:00:00Z') };
    const read = await listEvents('at', 'cal', window, paged);
    expect(read.complete).toBe(false);
    expect(read.events.every((e) => e.playerzId.startsWith('booking:'))).toBe(true);
    expect(read.events[0]!.start).toBe('2026-11-20T16:00:00.000Z');
  });

  it('a 401 from Calendar is a revoked grant; a 403 rate limit is not', async () => {
    const window = { from: new Date(), to: new Date(Date.now() + 1000) };
    const r401 = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const r403 = (async () =>
      new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', {
        status: 403,
      })) as typeof fetch;
    const r403s = (async () =>
      new Response('{"error":{"errors":[{"reason":"insufficientPermissions"}]}}', {
        status: 403,
      })) as typeof fetch;
    await expect(listEvents('at', 'c', window, r401)).rejects.toBeInstanceOf(
      GoogleGrantRevokedError,
    );
    await expect(listEvents('at', 'c', window, r403)).rejects.toBeInstanceOf(
      GoogleUnavailableError,
    );
    await expect(listEvents('at', 'c', window, r403s)).rejects.toBeInstanceOf(
      GoogleGrantRevokedError,
    );
  });
});

describe('busy or free', () => {
  const window = { from: new Date('2026-11-20T00:00:00Z'), to: new Date('2026-11-21T00:00:00Z') };

  it('merges the busy times of every calendar asked about', async () => {
    const g = new FakeGoogle();
    g.liveRefreshTokens.add('x');
    g.calendars.set('cal-p', { summary: 'playerz', events: new Map() });
    g.busy = {
      primary: [{ start: '2026-11-20T10:00:00Z', end: '2026-11-20T11:00:00Z' }],
      'cal-p': [{ start: '2026-11-20T10:30:00Z', end: '2026-11-20T12:00:00Z' }],
    };
    expect(await queryFreeBusy('at-x', ['primary', 'cal-p'], window, g.fetch)).toEqual([
      { start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T12:00:00.000Z' },
    ]);
  });

  it('a deleted playerz calendar is skipped; any other per-calendar error makes it unknown', async () => {
    const g = new FakeGoogle();
    g.liveRefreshTokens.add('x');
    expect(await queryFreeBusy('at-x', ['primary', 'cal-gone'], window, g.fetch)).toEqual([]);
    const broken = (async () =>
      new Response(
        JSON.stringify({ calendars: { primary: { errors: [{ reason: 'internalError' }] } } }),
        { status: 200 },
      )) as typeof fetch;
    expect(await queryFreeBusy('at', ['primary'], window, broken)).toBeNull();
  });

  it('mergeIntervals joins touching ranges and keeps gaps', () => {
    expect(
      mergeIntervals([
        { start: '2026-01-01T12:00:00.000Z', end: '2026-01-01T13:00:00.000Z' },
        { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:00:00.000Z' },
        { start: '2026-01-01T11:00:00.000Z', end: '2026-01-01T11:30:00.000Z' },
      ]),
    ).toEqual([
      { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:30:00.000Z' },
      { start: '2026-01-01T12:00:00.000Z', end: '2026-01-01T13:00:00.000Z' },
    ]);
  });
});
