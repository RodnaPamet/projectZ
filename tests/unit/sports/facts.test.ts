/** @jest-environment node */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { factOfTheWeek, factsProblems, loadFacts, sportsWithFacts } from '@/lib/sports/facts';

/**
 * The facts loader (owner 2026-11-13): one JSON file per sport, read from
 * disk, and a sport with no file has no facts rather than broken ones.
 */

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/sport-facts');
const fixture = () =>
  JSON.parse(readFileSync(path.join(FIXTURES, 'TENNIS.json'), 'utf8')) as {
    sport: string;
    facts: Array<{ bg: string; en: string; source: string }>;
  };

const previous = process.env.SPORT_FACTS_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.SPORT_FACTS_DIR;
  else process.env.SPORT_FACTS_DIR = previous;
});

describe('loading', () => {
  it('reads every valid file in the directory, by sport', () => {
    const all = loadFacts(FIXTURES);
    expect([...all.keys()]).toEqual(['TENNIS']);
    expect(all.get('TENNIS')!.facts).toHaveLength(52);
  });

  it('a missing directory is no facts, not an error', () => {
    expect(loadFacts(path.join(FIXTURES, 'nowhere')).size).toBe(0);
  });

  it('the committed directory loads (empty until the owner adds the texts)', () => {
    delete process.env.SPORT_FACTS_DIR;
    expect(() => sportsWithFacts()).not.toThrow();
  });

  it('factOfTheWeek answers the week’s fact in the language asked', () => {
    process.env.SPORT_FACTS_DIR = FIXTURES;
    // Friday 13 November 2026 is in the week of Monday the 9th: week 44, fact 45.
    const now = new Date('2026-11-13T09:00:00Z');
    expect(factOfTheWeek('TENNIS', 'en', now)).toEqual({
      sport: 'TENNIS',
      fact: { text: 'Tennis fact number 45.', number: 45, weekStart: '2026-11-09' },
    });
    expect(factOfTheWeek('TENNIS', 'bg', now)!.fact.text).toBe('Тенис факт номер 45.');
    expect(factOfTheWeek('PADEL', 'bg', now)).toBeNull();
  });

  it('a file that breaks a rule is left out and reported', () => {
    const reported: string[] = [];
    expect(loadFacts(FIXTURES, (file) => reported.push(file)).size).toBe(1);
    expect(reported).toEqual([]);
  });
});

describe('the rules a facts file keeps', () => {
  it('the fixture keeps them all', () => {
    expect(factsProblems(fixture(), 'TENNIS')).toEqual([]);
  });

  it('names a file whose sport is not the one it is named for', () => {
    expect(factsProblems(fixture(), 'PADEL')).toEqual([
      '"sport" is TENNIS but the file is named for PADEL',
    ]);
    expect(factsProblems({ ...fixture(), sport: 'CURLING' })[0]).toMatch(/not a sport key/);
  });

  it('exactly 52 facts, each with both languages and an https source', () => {
    const s = fixture();
    expect(factsProblems({ ...s, facts: s.facts.slice(1) })).toEqual([
      '"facts" must hold exactly 52',
    ]);
    s.facts[3] = { bg: 'Факт.', en: '', source: 'http://example.org' };
    expect(factsProblems(s)).toEqual([
      'facts[3].en is missing',
      'facts[3].source is not an https link',
    ]);
  });

  it('no letter Bulgarian does not use, in either case', () => {
    const s = fixture();
    s.facts[0]!.bg = 'Это факт.';
    s.facts[1]!.bg = 'Голяма любовь.';
    expect(factsProblems(s)).toEqual([
      'facts[0].bg has a letter Bulgarian does not use: Э',
      'facts[1].bg has a letter Bulgarian does not use: ь',
    ]);
    // «ьо» is Bulgarian.
    s.facts[0]!.bg = 'Шофьорът играе тенис.';
    s.facts[1]!.bg = 'Факт.';
    expect(factsProblems(s)).toEqual([]);
  });
});
