/**
 * @jest-environment node
 */
import { freeBusyFor } from '@/app-layer/usecases/google-calendar-sync';
import { encryptField } from '@/lib/security/encryption';

import { FakeGoogle } from '../../helpers/fake-google-calendar';

/**
 * `freeBusyFor` (owner 2026-11-14): busy intervals per person for the
 * assistant, from each connected person's primary and «playerz» calendars.
 * Google is the fake; the connections are a stub of the one superuser read.
 */

type Row = {
  id: string;
  userId: string;
  refreshTokenEnc: string;
  calendarId: string | null;
  status: 'ACTIVE' | 'REVOKED';
};
let rows: Row[] = [];
const updates: Array<{ where: unknown; data: unknown }> = [];

jest.mock('@/lib/db/rls-middleware', () => ({
  runAsSuperuser: async (fn: (db: unknown) => Promise<unknown>) =>
    fn({
      googleCalendarConnection: {
        findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
          rows.filter((r) => where.userId.in.includes(r.userId)),
        updateMany: async (args: { where: unknown; data: unknown }) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    }),
  runAsUserOnly: async () => {
    throw new Error('not used');
  },
}));

const from = new Date('2026-11-20T00:00:00Z');
const to = new Date('2026-11-27T00:00:00Z');

describe('freeBusyFor', () => {
  const env = { ...process.env };
  let g: FakeGoogle;

  beforeEach(() => {
    process.env.GOOGLE_CALENDAR_SYNC = '1';
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    g = new FakeGoogle();
    g.liveRefreshTokens.add('rt-a');
    g.calendars.set('cal-a', { summary: 'playerz', events: new Map() });
    g.busy = {
      primary: [{ start: '2026-11-21T08:00:00Z', end: '2026-11-21T09:00:00Z' }],
      'cal-a': [{ start: '2026-11-22T17:00:00Z', end: '2026-11-22T18:30:00Z' }],
    };
    rows = [
      {
        id: 'c1',
        userId: 'ua',
        refreshTokenEnc: encryptField('rt-a'),
        calendarId: 'cal-a',
        status: 'ACTIVE',
      },
      {
        id: 'c2',
        userId: 'ub',
        refreshTokenEnc: encryptField('rt-b'),
        calendarId: null,
        status: 'ACTIVE',
      },
      {
        id: 'c3',
        userId: 'uc',
        refreshTokenEnc: encryptField('rt-c'),
        calendarId: null,
        status: 'REVOKED',
      },
    ];
    updates.length = 0;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('answers busy times per person, and unknown, never free, for everyone else', async () => {
    const answer = await freeBusyFor(['ua', 'ub', 'uc', 'ud'], from, to, { fetchImpl: g.fetch });
    expect(answer.ua).toEqual({
      known: true,
      busy: [
        { start: '2026-11-21T08:00:00.000Z', end: '2026-11-21T09:00:00.000Z' },
        { start: '2026-11-22T17:00:00.000Z', end: '2026-11-22T18:30:00.000Z' },
      ],
    });
    // rt-b is not a live token at Google: invalid_grant → revoked, and recorded.
    expect(answer.ub).toEqual({ known: false, reason: 'revoked' });
    expect(updates).toEqual([
      { where: { id: 'c2' }, data: { status: 'REVOKED', lastError: 'GOOGLE_REVOKED' } },
    ]);
    expect(answer.uc).toEqual({ known: false, reason: 'revoked' });
    expect(answer.ud).toEqual({ known: false, reason: 'not_connected' });
  });

  it('asks Google about the primary calendar and the playerz one, over exactly the range', async () => {
    await freeBusyFor(['ua'], from, to, { fetchImpl: g.fetch });
    const call = g.calls.find((c) => c.url.endsWith('/freeBusy'));
    expect(call?.method).toBe('POST');
  });

  it('Google down is unknown for that person', async () => {
    g.calendarStatus = 503;
    expect((await freeBusyFor(['ua'], from, to, { fetchImpl: g.fetch })).ua).toEqual({
      known: false,
      reason: 'unavailable',
    });
  });

  it('switched off, everyone is unknown and Google is not called', async () => {
    process.env.GOOGLE_CALENDAR_SYNC = '0';
    expect(await freeBusyFor(['ua'], from, to, { fetchImpl: g.fetch })).toEqual({
      ua: { known: false, reason: 'disabled' },
    });
    expect(g.calls).toEqual([]);
  });

  it('refuses a backwards or too-long range, and too many people', async () => {
    await expect(freeBusyFor(['ua'], to, from)).rejects.toThrow(RangeError);
    await expect(freeBusyFor(['ua'], from, new Date('2027-03-01T00:00:00Z'))).rejects.toThrow(
      RangeError,
    );
    const many = Array.from({ length: 21 }, (_, i) => `u${i}`);
    await expect(freeBusyFor(many, from, to)).rejects.toThrow(RangeError);
  });
});
