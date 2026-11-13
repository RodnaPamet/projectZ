import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { SportType } from '@prisma/client';
import { fromZonedTime } from 'date-fns-tz';

import type { Locale } from '@/lib/i18n/locales';
import { localDay } from '@/lib/notifications/dedupe';
import { logger } from '@/lib/observability/logger';
import { isSportKey } from '@/lib/sports/registry';

/**
 * A SPORT'S STORY AND ITS FACT OF THE DAY (owner 2026-11-13).
 *
 * Every sport has a short, funny history (two paragraphs) and 52 fun facts,
 * in Bulgarian and English. The sport pages show the history and today's
 * fact, and a daily push sends today's fact for each player's main sport.
 *
 * ═══ A STORY IS A FILE ═══
 *
 *   src/content/sport-stories/<SPORT>.json
 *
 *   { "sport": "TENNIS",
 *     "history": { "bg": ["…", "…"], "en": ["…", "…"] },
 *     "facts": [ { "bg": "…", "en": "…", "source": "https://…" }, …52 ] }
 *
 * Read from disk once per process, on first use, not bundled: the owner adds
 * and edits the texts, and a text is a commit and a deploy, as the legal
 * texts are. The image carries the directory (Dockerfile). A sport with no
 * file has no story, and its route answers 404; nothing stands in for one.
 * A file that breaks the rules below is left out and logged, so one bad edit
 * hides one sport rather than failing every request; the guardrail
 * `sport-stories` fails the build on it first.
 *
 * ═══ THE FACT OF THE DAY ═══
 *
 * Day n counts from 2026-01-01 on the Sofia wall clock, and the fact is
 * n mod 52. Every sport has 52, so a year shows each fact once, give or take
 * a day, and the fact changes at midnight in Sofia for everyone, wherever
 * their phone is. Counting Sofia DAYS rather than 24-hour blocks is what keeps
 * the change at midnight across the DST switch, when a day is 23 or 25 hours.
 */

export const FACTS_PER_SPORT = 52;
export const HISTORY_PARAGRAPHS = 2;
export const MAX_SENTENCES_PER_PARAGRAPH = 3;
export const STORY_TIME_ZONE = 'Europe/Sofia';
/** Day 0: the fact of 2026-01-01 is fact 1. */
export const STORY_EPOCH_DAY = '2026-01-01';

/**
 * Letters and soft-sign uses that do not exist in Bulgarian but do in Russian
 * (owner 2026-10-31: an AI draft once slipped Russianisms in). «ьо» is the one
 * Bulgarian use of «ь». Either case: «Это» starts a sentence.
 */
export const RUSSIANISM = /[ыэё]|ь(?!о)/iu;

export interface SportFact {
  bg: string;
  en: string;
  source: string;
}

export interface SportStory {
  sport: SportType;
  history: Record<Locale, string[]>;
  facts: SportFact[];
}

/**
 * How many sentences a paragraph has: each run of `.`, `!`, `?` or `…` that
 * ends the text or is followed by a space and a capital letter. A date such as
 * «1877 г. Първият…» counts as a break; write around it rather than loosen
 * the rule, which is there to keep the history short.
 */
export function countSentences(text: string): number {
  return [...text.trim().matchAll(/[.!?…]+["»”')]*(?=\s+["«„(]?[A-ZА-Я]|$)/gu)].length;
}

/** What is wrong with a story file, as sentences; empty when it is fine. */
export function storyProblems(raw: unknown, fileSport?: string): string[] {
  const problems: string[] = [];
  if (raw === null || typeof raw !== 'object') return ['the file is not a JSON object'];
  const s = raw as Record<string, unknown>;

  if (!isSportKey(s.sport)) problems.push(`"sport" is not a sport key: ${String(s.sport)}`);
  else if (fileSport !== undefined && s.sport !== fileSport) {
    problems.push(`"sport" is ${s.sport} but the file is named for ${fileSport}`);
  }

  const history = s.history as Record<string, unknown> | undefined;
  for (const locale of ['bg', 'en'] as const) {
    const paragraphs = history?.[locale];
    if (!Array.isArray(paragraphs) || paragraphs.length !== HISTORY_PARAGRAPHS) {
      problems.push(`history.${locale} must be ${HISTORY_PARAGRAPHS} paragraphs`);
      continue;
    }
    paragraphs.forEach((p, i) => {
      if (typeof p !== 'string' || p.trim() === '') {
        problems.push(`history.${locale}[${i}] is empty`);
        return;
      }
      const n = countSentences(p);
      if (n > MAX_SENTENCES_PER_PARAGRAPH) {
        problems.push(
          `history.${locale}[${i}] has ${n} sentences, at most ${MAX_SENTENCES_PER_PARAGRAPH}`,
        );
      }
      if (locale === 'bg' && RUSSIANISM.test(p)) {
        problems.push(
          `history.bg[${i}] has a letter Bulgarian does not use: ${RUSSIANISM.exec(p)![0]}`,
        );
      }
    });
  }

  if (!Array.isArray(s.facts) || s.facts.length !== FACTS_PER_SPORT) {
    problems.push(`"facts" must hold exactly ${FACTS_PER_SPORT}`);
  } else {
    s.facts.forEach((f: unknown, i) => {
      const fact = (f ?? {}) as Record<string, unknown>;
      for (const key of ['bg', 'en', 'source'] as const) {
        if (typeof fact[key] !== 'string' || (fact[key] as string).trim() === '') {
          problems.push(`facts[${i}].${key} is missing`);
        }
      }
      if (typeof fact.source === 'string' && !/^https:\/\/\S+$/.test(fact.source)) {
        problems.push(`facts[${i}].source is not an https link`);
      }
      if (typeof fact.bg === 'string' && RUSSIANISM.test(fact.bg)) {
        problems.push(
          `facts[${i}].bg has a letter Bulgarian does not use: ${RUSSIANISM.exec(fact.bg)![0]}`,
        );
      }
    });
  }
  return problems;
}

/**
 * The directory the stories live in. `SPORT_STORIES_DIR` points a test at a
 * fixture; nothing in a deployment sets it.
 */
export function storiesRoot(): string {
  return (
    process.env.SPORT_STORIES_DIR ?? path.join(process.cwd(), 'src', 'content', 'sport-stories')
  );
}

/**
 * Every valid story in `root`, by sport. A missing directory is no stories.
 * Synchronous on purpose: it runs once per process, and a reader never sees
 * half a map.
 */
export function loadStories(
  root: string = storiesRoot(),
  onProblem: (file: string, problems: string[]) => void = () => {},
): ReadonlyMap<SportType, SportStory> {
  const stories = new Map<SportType, SportStory>();
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return stories;
    throw err;
  }
  for (const file of files.sort()) {
    const fileSport = file.replace(/\.json$/, '');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    } catch {
      onProblem(file, ['the file is not valid JSON']);
      continue;
    }
    const problems = storyProblems(raw, fileSport);
    if (problems.length > 0) {
      onProblem(file, problems);
      continue;
    }
    const s = raw as SportStory;
    stories.set(s.sport, {
      sport: s.sport,
      history: { bg: [...s.history.bg], en: [...s.history.en] },
      facts: s.facts.map((f) => ({ bg: f.bg, en: f.en, source: f.source })),
    });
  }
  return stories;
}

let loaded: { root: string; stories: ReadonlyMap<SportType, SportStory> } | null = null;

/**
 * The stories, read once. Keyed on the directory so a test that points
 * `SPORT_STORIES_DIR` elsewhere reads that, not what an earlier test cached.
 */
function stories(): ReadonlyMap<SportType, SportStory> {
  const root = storiesRoot();
  if (loaded?.root !== root) {
    loaded = {
      root,
      // One line per bad file, once per process.
      stories: loadStories(root, (file, problems) =>
        logger.error('sport story left out', { component: 'sport-stories', file, problems }),
      ),
    };
  }
  return loaded.stories;
}

/** The sports that have a story, in file-name order. */
export function sportsWithStories(): SportType[] {
  return [...stories().keys()];
}

/** `YYYY-MM-DD` of `at` on the Sofia wall clock. */
export function storyDay(at: Date): string {
  return localDay(at, STORY_TIME_ZONE);
}

const MS_PER_DAY = 86_400_000;

/** Whole Sofia days from 2026-01-01 to `at`'s Sofia day; negative before it. */
export function storyDayNumber(at: Date): number {
  // Both are calendar dates, so their UTC midnights are a whole number of
  // days apart whatever the offset was on either day.
  return Math.round(
    (Date.parse(`${storyDay(at)}T00:00:00Z`) - Date.parse(`${STORY_EPOCH_DAY}T00:00:00Z`)) /
      MS_PER_DAY,
  );
}

/** Which fact `at` shows, 0–51: Sofia days since 2026-01-01, mod 52. */
export function factIndex(at: Date): number {
  return ((storyDayNumber(at) % FACTS_PER_SPORT) + FACTS_PER_SPORT) % FACTS_PER_SPORT;
}

/** The next midnight on the Sofia wall clock after `at`: when the fact changes. */
export function nextStoryMidnight(at: Date): Date {
  const [y, m, d] = storyDay(at).split('-').map(Number) as [number, number, number];
  // The next calendar day, as a date with no zone, then pinned to Sofia.
  // Midnight always exists there: the DST switches happen at 03:00 and 04:00.
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, STORY_TIME_ZONE);
}

/** No story for this sport yet: `GET /sports/{sport}/story` answers 404 STORY_NOT_FOUND. */
export class SportStoryNotFoundError extends Error {
  constructor(sport: SportType) {
    super(`No story for ${sport} yet`);
    this.name = 'SportStoryNotFoundError';
  }
}

export interface StoryForDay {
  sport: SportType;
  history: string[];
  fact: { text: string; number: number; date: string };
}

/** The history and the fact of `at`'s Sofia day, in `locale`; null with no story. */
export function storyFor(
  sport: SportType,
  locale: Locale,
  at: Date = new Date(),
): StoryForDay | null {
  const story = stories().get(sport);
  if (!story) return null;
  const index = factIndex(at);
  return {
    sport,
    history: [...story.history[locale]],
    fact: { text: story.facts[index]![locale], number: index + 1, date: storyDay(at) },
  };
}
