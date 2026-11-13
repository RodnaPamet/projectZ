/** @jest-environment node */

import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/v1/sports/[sport]/fact/route';

/**
 * GET /api/v1/sports/{sport}/fact (owner 2026-11-13): public, in the
 * request's language, cached until the fact changes at Monday 00:00 Sofia.
 */

const previous = process.env.SPORT_FACTS_DIR;
beforeAll(() => {
  process.env.SPORT_FACTS_DIR = path.join(process.cwd(), 'tests/fixtures/sport-facts');
});
afterAll(() => {
  if (previous === undefined) delete process.env.SPORT_FACTS_DIR;
  else process.env.SPORT_FACTS_DIR = previous;
});

// Only the clock is faked: the route awaits real promises.
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-13T09:00:00Z'),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  });
});
afterEach(() => jest.useRealTimers());

const get = async (sport: string, query = '', headers: Record<string, string> = {}) => {
  const res = await GET(
    new NextRequest(`http://t/api/v1/sports/${sport}/fact${query}`, { headers }),
    { params: Promise.resolve({ sport }) },
  );
  return { res, body: await res.json() };
};

describe('GET /api/v1/sports/{sport}/fact', () => {
  it('answers the fact of the Sofia week, with no session', async () => {
    const { res, body } = await get('TENNIS', '?locale=en');
    expect(res.status).toBe(200);
    expect(body).toEqual({
      data: {
        sport: 'TENNIS',
        fact: { text: 'Tennis fact number 45.', number: 45, weekStart: '2026-11-09' },
      },
    });
  });

  it('is Bulgarian unless asked otherwise, and follows the web’s language cookie', async () => {
    expect((await get('TENNIS')).body.data.fact.text).toBe('Тенис факт номер 45.');
    expect((await get('TENNIS', '?locale=xx')).body.data.fact.text).toBe('Тенис факт номер 45.');
    const cookie = await get('TENNIS', '', { cookie: 'NEXT_LOCALE=en' });
    expect(cookie.body.data.fact.text).toBe('Tennis fact number 45.');
    // The query wins over the cookie: it is what the caller asked for by name.
    const both = await get('TENNIS', '?locale=bg', { cookie: 'NEXT_LOCALE=en' });
    expect(both.body.data.fact.text).toBe('Тенис факт номер 45.');
  });

  it('is cached publicly until Monday 00:00 in Sofia, by language', async () => {
    const { res } = await get('TENNIS', '?locale=en');
    // Friday 09:00 UTC; Monday 00:00 Sofia is Sunday 22:00 UTC, 61 hours on.
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${61 * 3600}`);
    expect(res.headers.get('vary')).toBe('Cookie, Authorization');
  });

  it('400 for a sport this server does not know', async () => {
    const { res, body } = await get('CURLING');
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({ code: 'BAD_REQUEST', details: { field: 'sport' } });
  });

  it('404 FACT_NOT_FOUND for a sport with no facts yet', async () => {
    const { res, body } = await get('PADEL');
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('FACT_NOT_FOUND');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
