import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { SportType } from '@prisma/client';
import { fromZonedTime } from 'date-fns-tz';

import type { Locale } from '@/lib/i18n/locales';
import { localDay } from '@/lib/notifications/dedupe';
import { logger } from '@/lib/observability/logger';
import { isSportKey } from '@/lib/sports/registry';

/**
 * A SPORT'S FACT OF THE WEEK (owner 2026-11-13).
 *
 * Every sport has 52 fun facts, in Bulgarian and English: one a week, so a
 * year shows each once. The sport pages show this week's fact, and a weekly
 * push on Monday sends it for each player's main sport.
 *
 * ═══ THE FACTS ARE A FILE PER SPORT ═══
 *
 *   src/content/sport-facts/<SPORT>.json
 *
 *   { "sport": "TENNIS",
 *     "facts": [ { "bg": "…", "en": "…", "source": "https://…" }, …52 ] }
 *
 * Read from disk once per process, on first use, not bundled: the owner adds
 * and edits the texts, and a text is a commit and a deploy, as the legal
 * texts are. The image carries the directory (Dockerfile). A sport with no
 * file has no facts, and its route answers 404; nothing stands in for them.
 * A file that breaks the rules below is left out and logged, so one bad edit
 * hides one sport rather than failing every request; the guardrail
 * `sport-facts` fails the build on it first.
 *
 * ═══ THE FACT OF THE WEEK ═══
 *
 * Week n counts from Monday 2026-01-05 on the Sofia wall clock, and the fact
 * is n mod 52. It changes at Monday 00:00 in Sofia for everyone, wherever
 * their phone is. Counting Sofia calendar DAYS, then weeks of seven of them,
 * rather than 168-hour blocks is what keeps the change at midnight across the
 * DST switch, when a week is an hour shorter or longer.
 */

export const FACTS_PER_SPORT = 52;
export const FACT_TIME_ZONE = 'Europe/Sofia';
/** Week 0 starts on this Monday: its fact is fact 1. */
export const FACT_EPOCH_MONDAY = '2026-01-05';

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

export interface SportFacts {
  sport: SportType;
  facts: SportFact[];
}

/** What is wrong with a facts file, as sentences; empty when it is fine. */
export function factsProblems(raw: unknown, fileSport?: string): string[] {
  const problems: string[] = [];
  if (raw === null || typeof raw !== 'object') return ['the file is not a JSON object'];
  const s = raw as Record<string, unknown>;

  if (!isSportKey(s.sport)) problems.push(`"sport" is not a sport key: ${String(s.sport)}`);
  else if (fileSport !== undefined && s.sport !== fileSport) {
    problems.push(`"sport" is ${s.sport} but the file is named for ${fileSport}`);
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
 * The directory the facts live in. `SPORT_FACTS_DIR` points a test at a
 * fixture; nothing in a deployment sets it.
 */
export function factsRoot(): string {
  return process.env.SPORT_FACTS_DIR ?? path.join(process.cwd(), 'src', 'content', 'sport-facts');
}

/**
 * Every valid facts file in `root`, by sport. A missing directory is none.
 * Synchronous on purpose: it runs once per process, and a reader never sees
 * half a map.
 */
export function loadFacts(
  root: string = factsRoot(),
  onProblem: (file: string, problems: string[]) => void = () => {},
): ReadonlyMap<SportType, SportFacts> {
  const all = new Map<SportType, SportFacts>();
  let files: string[];
  try {
    files = readdirSync(root).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return all;
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
    const problems = factsProblems(raw, fileSport);
    if (problems.length > 0) {
      onProblem(file, problems);
      continue;
    }
    const s = raw as SportFacts;
    all.set(s.sport, {
      sport: s.sport,
      facts: s.facts.map((f) => ({ bg: f.bg, en: f.en, source: f.source })),
    });
  }
  return all;
}

let loaded: { root: string; facts: ReadonlyMap<SportType, SportFacts> } | null = null;

/**
 * The facts, read once. Keyed on the directory so a test that points
 * `SPORT_FACTS_DIR` elsewhere reads that, not what an earlier test cached.
 */
function facts(): ReadonlyMap<SportType, SportFacts> {
  const root = factsRoot();
  if (loaded?.root !== root) {
    loaded = {
      root,
      // One line per bad file, once per process.
      facts: loadFacts(root, (file, problems) =>
        logger.error('sport facts left out', { component: 'sport-facts', file, problems }),
      ),
    };
  }
  return loaded.facts;
}

/** The sports that have facts, in file-name order. */
export function sportsWithFacts(): SportType[] {
  return [...facts().keys()];
}

const MS_PER_DAY = 86_400_000;

/** A `YYYY-MM-DD` calendar date as its UTC midnight, for day arithmetic. */
const dateMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday (`YYYY-MM-DD`, Sofia calendar) of the week `at` falls in. */
export function factWeekStart(at: Date): string {
  const day = dateMs(localDay(at, FACT_TIME_ZONE));
  // getUTCDay of a calendar date's UTC midnight is that date's weekday;
  // Monday is 1, Sunday 0, so Sunday goes back six days.
  const back = (new Date(day).getUTCDay() + 6) % 7;
  return dayOf(day - back * MS_PER_DAY);
}

/** Whole Sofia weeks from Monday 2026-01-05 to `at`'s week; negative before it. */
export function factWeekNumber(at: Date): number {
  return Math.round((dateMs(factWeekStart(at)) - dateMs(FACT_EPOCH_MONDAY)) / (7 * MS_PER_DAY));
}

/** Which fact `at` shows, 0–51: Sofia weeks since Monday 2026-01-05, mod 52. */
export function factIndex(at: Date): number {
  return ((factWeekNumber(at) % FACTS_PER_SPORT) + FACTS_PER_SPORT) % FACTS_PER_SPORT;
}

/** Next Monday 00:00 on the Sofia wall clock after `at`: when the fact changes. */
export function nextFactWeekStart(at: Date): Date {
  const next = dayOf(dateMs(factWeekStart(at)) + 7 * MS_PER_DAY);
  // Midnight always exists in Sofia: the DST switches happen at 03:00 and 04:00.
  return fromZonedTime(`${next}T00:00:00`, FACT_TIME_ZONE);
}

/**
 * The ISO week of `at`'s Sofia Monday, `2026-W46`: the push's once-a-week
 * key. The ISO year is the year of that week's Thursday, so the Monday
 * 2026-12-28 is `2026-W53` and 2027-01-04 is `2027-W01`.
 */
export function factIsoWeek(at: Date): string {
  const thursday = dateMs(factWeekStart(at)) + 3 * MS_PER_DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * MS_PER_DAY)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** No facts for this sport yet: `GET /sports/{sport}/fact` answers 404 FACT_NOT_FOUND. */
export class SportFactsNotFoundError extends Error {
  constructor(sport: SportType) {
    super(`No facts for ${sport} yet`);
    this.name = 'SportFactsNotFoundError';
  }
}

export interface FactOfTheWeek {
  sport: SportType;
  fact: { text: string; number: number; weekStart: string };
}

/** The fact of `at`'s Sofia week, in `locale`; null when the sport has none. */
export function factOfTheWeek(
  sport: SportType,
  locale: Locale,
  at: Date = new Date(),
): FactOfTheWeek | null {
  const entry = facts().get(sport);
  if (!entry) return null;
  const index = factIndex(at);
  return {
    sport,
    fact: { text: entry.facts[index]![locale], number: index + 1, weekStart: factWeekStart(at) },
  };
}
