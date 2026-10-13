import type { SportType } from '@prisma/client';

import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL, PROFILE_SPORTS } from '@/lib/profile/limits';

/**
 * What a coach's profile may hold, and what it needs before it can be sent
 * for approval (#377, owner decision 13). Pure: no database, no zod, so the
 * form in the browser and the use case on the server apply the same rules
 * from the same numbers. The database holds the same limits as CHECKs (P71).
 */

export const COACH_BIO_MAX = 1000;
/** Under this a text says nothing a player or the owner could judge by. */
export const COACH_BIO_MIN = 40;
export const COACH_QUALIFICATIONS_MAX = 1000;
/** The owner's note to the coach with a decision. */
export const COACH_DECISION_NOTE_MAX = 500;
/** A decline or a removal says why, in at least this much. */
export const COACH_DECISION_NOTE_MIN = 10;

/** The sports a coach can teach: the ones a player declares a level in. */
export const COACH_SPORTS: readonly SportType[] = PROFILE_SPORTS;

export interface CoachSportInput {
  sport: SportType;
  levelMin: number;
  levelMax: number;
}

export interface CoachProfileInput {
  bio: string | null;
  qualifications: string | null;
  sports: CoachSportInput[];
}

export type CoachProfileField = 'bio' | 'qualifications' | 'sports';
export type CoachProfileFieldError = 'TOO_LONG' | 'UNKNOWN_SPORT' | 'DUPLICATE_SPORT' | 'LEVELS';

export class CoachProfileInvalidError extends Error {
  constructor(
    readonly field: CoachProfileField,
    readonly reason: CoachProfileFieldError,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'CoachProfileInvalidError';
  }
}

/**
 * Free text as it is kept: line endings as `\n`, no trailing spaces, at most
 * one blank line in a row, trimmed; empty is null. The caller has already
 * stripped markup (`sanitizePlainText`), which needs the server.
 */
export function tidyCoachText(raw: unknown): string | null {
  const text = (typeof raw === 'string' ? raw : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

const isLevel = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= MIN_SPORT_LEVEL && n <= MAX_SPORT_LEVEL;

/**
 * Read a profile as typed into a shape that can be stored, or say which
 * field is wrong and why. Sports come back in the registry's order, so two
 * saves of the same choices are the same rows.
 */
export function readCoachProfileInput(raw: {
  bio?: unknown;
  qualifications?: unknown;
  sports?: unknown;
}): CoachProfileInput {
  const bio = tidyCoachText(raw.bio);
  if (bio && bio.length > COACH_BIO_MAX) throw new CoachProfileInvalidError('bio', 'TOO_LONG');
  const qualifications = tidyCoachText(raw.qualifications);
  if (qualifications && qualifications.length > COACH_QUALIFICATIONS_MAX) {
    throw new CoachProfileInvalidError('qualifications', 'TOO_LONG');
  }

  const list = Array.isArray(raw.sports) ? raw.sports : [];
  const seen = new Map<SportType, CoachSportInput>();
  for (const item of list) {
    const s = (item ?? {}) as { sport?: unknown; levelMin?: unknown; levelMax?: unknown };
    const sport = COACH_SPORTS.find((k) => k === s.sport);
    if (!sport) throw new CoachProfileInvalidError('sports', 'UNKNOWN_SPORT');
    if (seen.has(sport)) throw new CoachProfileInvalidError('sports', 'DUPLICATE_SPORT');
    if (!isLevel(s.levelMin) || !isLevel(s.levelMax) || s.levelMin > s.levelMax) {
      throw new CoachProfileInvalidError('sports', 'LEVELS');
    }
    seen.set(sport, { sport, levelMin: s.levelMin, levelMax: s.levelMax });
  }
  return {
    bio,
    qualifications,
    sports: COACH_SPORTS.filter((k) => seen.has(k)).map((k) => seen.get(k)!),
  };
}

/** What a profile still lacks before it can be sent for approval. */
export type CoachProfileMissing = 'bio' | 'sports' | 'certificate';

export function missingForSubmission(p: {
  bio: string | null;
  sports: readonly unknown[];
  hasCertificate: boolean;
}): CoachProfileMissing[] {
  return [
    ...((p.bio?.length ?? 0) >= COACH_BIO_MIN ? [] : (['bio'] as const)),
    ...(p.sports.length > 0 ? [] : (['sports'] as const)),
    ...(p.hasCertificate ? [] : (['certificate'] as const)),
  ];
}

// ─── What each state lets the coach change ─────────────────────────────────

export type CoachProfileState = 'NONE' | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'DECLINED';

/**
 * The text and sports: always, except while the owner is reading them. What
 * was sent is what gets decided; a coach who wants to change it takes the
 * profile back first. An approved coach edits freely, as a club edits its own
 * description.
 */
export const canEditCoachText = (state: CoachProfileState): boolean => state !== 'SUBMITTED';

/**
 * The certificate: until it is sent, and again after a decline. Not while it
 * is being read, and not once approved: the approval was given on THIS
 * document, and it is kept for as long as the coach is active (decision 17).
 */
export const canChangeCertificate = (state: CoachProfileState): boolean =>
  state === 'NONE' || state === 'DRAFT' || state === 'DECLINED';

// ─── The address of a coach's page ─────────────────────────────────────────

/** Bulgarian to Latin, the official streamlined system (2009 law). */
const BG_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
};

export const COACH_SLUG_MAX = 48;
/** What a slug is when the name gives nothing to make one from. */
export const COACH_SLUG_FALLBACK = 'trenyor';

/**
 * A page address from a person's name: «Иван Петров» → `ivan-petrov`.
 * Lowercase Latin, digits and single hyphens, never empty, never longer than
 * `COACH_SLUG_MAX`. Matches the database's CHECK (`coach_profile_slug_format`).
 */
export function coachSlugBase(name: string | null | undefined): string {
  const latin = Array.from((name ?? '').toLowerCase().normalize('NFKD'))
    // «ия» at the end of a word is `ia`, by the same law.
    .join('')
    .replace(/ия(?=$|[^\p{L}])/gu, 'ia')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[а-яё]/g, (c) => BG_LATIN[c] ?? '');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, COACH_SLUG_MAX)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : COACH_SLUG_FALLBACK;
}

/** The nth candidate for a slug: the base, then `base-2`, `base-3`, … */
export function coachSlugCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}
