/** @jest-environment node */

import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/v1/sports/[sport]/story/route';

/**
 * GET /api/v1/sports/{sport}/story (owner 2026-11-13): public, in the
 * request's language, cached until the fact changes at midnight in Sofia.
 */

const previous = process.env.SPORT_STORIES_DIR;
beforeAll(() => {
  process.env.SPORT_STORIES_DIR = path.join(process.cwd(), 'tests/fixtures/sport-stories');
});
afterAll(() => {
  if (previous === undefined) delete process.env.SPORT_STORIES_DIR;
  else process.env.SPORT_STORIES_DIR = previous;
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
    new NextRequest(`http://t/api/v1/sports/${sport}/story${query}`, { headers }),
    { params: Promise.resolve({ sport }) },
  );
  return { res, body: await res.json() };
};

describe('GET /api/v1/sports/{sport}/story', () => {
  it('answers the history and the fact of the Sofia day, with no session', async () => {
    const { res, body } = await get('TENNIS', '?locale=en');
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      sport: 'TENNIS',
      history: [expect.stringMatching(/^Tennis began/), expect.stringMatching(/^Wimbledon/)],
      fact: { text: 'Tennis fact number 5.', number: 5, date: '2026-11-13' },
    });
  });

  it('is Bulgarian unless asked otherwise, and follows the web’s language cookie', async () => {
    expect((await get('TENNIS')).body.data.fact.text).toBe('Тенис факт номер 5.');
    expect((await get('TENNIS', '?locale=xx')).body.data.fact.text).toBe('Тенис факт номер 5.');
    const cookie = await get('TENNIS', '', { cookie: 'NEXT_LOCALE=en' });
    expect(cookie.body.data.fact.text).toBe('Tennis fact number 5.');
    // The query wins over the cookie: it is what the caller asked for by name.
    const both = await get('TENNIS', '?locale=bg', { cookie: 'NEXT_LOCALE=en' });
    expect(both.body.data.fact.text).toBe('Тенис факт номер 5.');
  });

  it('is cached publicly until midnight in Sofia, by language', async () => {
    const { res } = await get('TENNIS', '?locale=en');
    // 09:00 UTC is 11:00 in Sofia; midnight is 22:00 UTC, 13 hours on.
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${13 * 3600}`);
    expect(res.headers.get('vary')).toBe('Cookie, Authorization');
  });

  it('400 for a sport this server does not know', async () => {
    const { res, body } = await get('CURLING');
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({ code: 'BAD_REQUEST', details: { field: 'sport' } });
  });

  it('404 STORY_NOT_FOUND for a sport with no story yet', async () => {
    const { res, body } = await get('PADEL');
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('STORY_NOT_FOUND');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
