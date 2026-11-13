/** @jest-environment node */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  countSentences,
  loadStories,
  sportsWithStories,
  storyFor,
  storyProblems,
} from '@/lib/sports/stories';

/**
 * The story loader (owner 2026-11-13): one JSON file per sport, read from
 * disk, and a sport with no file has no story rather than a broken one.
 */

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/sport-stories');
const fixture = () =>
  JSON.parse(readFileSync(path.join(FIXTURES, 'TENNIS.json'), 'utf8')) as {
    sport: string;
    history: { bg: string[]; en: string[] };
    facts: Array<{ bg: string; en: string; source: string }>;
  };

const previous = process.env.SPORT_STORIES_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.SPORT_STORIES_DIR;
  else process.env.SPORT_STORIES_DIR = previous;
});

describe('loading', () => {
  it('reads every valid file in the directory, by sport', () => {
    const stories = loadStories(FIXTURES);
    expect([...stories.keys()]).toEqual(['TENNIS']);
    expect(stories.get('TENNIS')!.facts).toHaveLength(52);
  });

  it('a missing directory is no stories, not an error', () => {
    expect(loadStories(path.join(FIXTURES, 'nowhere')).size).toBe(0);
  });

  it('the committed directory loads (empty until the owner adds the texts)', () => {
    delete process.env.SPORT_STORIES_DIR;
    expect(() => sportsWithStories()).not.toThrow();
  });

  it('storyFor answers the history and the day’s fact in the language asked', () => {
    process.env.SPORT_STORIES_DIR = FIXTURES;
    // 13 November 2026 in Sofia is day 316 since 1 January: fact 316 mod 52 + 1 = 5.
    const now = new Date('2026-11-13T09:00:00Z');
    expect(storyFor('TENNIS', 'en', now)).toEqual({
      sport: 'TENNIS',
      history: fixture().history.en,
      fact: { text: 'Tennis fact number 5.', number: 5, date: '2026-11-13' },
    });
    expect(storyFor('TENNIS', 'bg', now)!.fact.text).toBe('Тенис факт номер 5.');
    expect(storyFor('PADEL', 'bg', now)).toBeNull();
  });
});

describe('the rules a story file keeps', () => {
  it('the fixture keeps them all', () => {
    expect(storyProblems(fixture(), 'TENNIS')).toEqual([]);
  });

  it('names a file whose sport is not the one it is named for', () => {
    expect(storyProblems(fixture(), 'PADEL')).toEqual([
      '"sport" is TENNIS but the file is named for PADEL',
    ]);
    expect(storyProblems({ ...fixture(), sport: 'CURLING' })[0]).toMatch(/not a sport key/);
  });

  it('two paragraphs per language, three sentences each at most', () => {
    const s = fixture();
    s.history.en = [s.history.en[0]!];
    s.history.bg[1] = 'Едно. Две. Три. Четири.';
    expect(storyProblems(s, 'TENNIS')).toEqual([
      'history.bg[1] has 4 sentences, at most 3',
      'history.en must be 2 paragraphs',
    ]);
  });

  it('exactly 52 facts, each with both languages and an https source', () => {
    const s = fixture();
    expect(storyProblems({ ...s, facts: s.facts.slice(1) })).toEqual([
      '"facts" must hold exactly 52',
    ]);
    s.facts[3] = { bg: 'Факт.', en: '', source: 'http://example.org' };
    expect(storyProblems(s)).toEqual([
      'facts[3].en is missing',
      'facts[3].source is not an https link',
    ]);
  });

  it('no letter Bulgarian does not use, in the history or a fact', () => {
    const s = fixture();
    s.history.bg[0] = 'Тенисът е объект на любовь.';
    s.facts[0]!.bg = 'Это факт.';
    expect(storyProblems(s)).toEqual([
      'history.bg[0] has a letter Bulgarian does not use: ь',
      'facts[0].bg has a letter Bulgarian does not use: Э',
    ]);
    // «ьо» is Bulgarian.
    s.history.bg[0] = 'Шофьорът играе тенис.';
    s.facts[0]!.bg = 'Факт.';
    expect(storyProblems(s)).toEqual([]);
  });

  it('counts sentences by their ends, not by every full stop', () => {
    expect(countSentences('One. Two! Three? Four…')).toBe(4);
    expect(countSentences('Версия 2.0 е тук.')).toBe(1);
    expect(countSentences('«Добре!» каза той. После спря.')).toBe(2);
    expect(countSentences('No full stop at the end')).toBe(0);
  });

  it('a file that breaks a rule is left out and reported, the rest still load', () => {
    const reported: string[] = [];
    const stories = loadStories(FIXTURES, (file) => reported.push(file));
    expect(reported).toEqual([]);
    expect(stories.size).toBe(1);
  });
});
