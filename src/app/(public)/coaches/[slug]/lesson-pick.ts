import { coachPath } from '@/lib/coaches/hrefs';

/**
 * What the coach page's URL says about a lesson being picked (#548), and the
 * page's own URL for a pick. The same idea as the venue page's
 * (`booking-days.ts`): the pick rides in the query string so a reload keeps
 * it, and a signed-out visitor's «Запиши урок» can go to /login and come
 * back to the same venue, day and time.
 */

/** One venue a lesson can be booked at, as far as the picker needs to know. */
export interface PickableVenue {
  linkId: string;
  sports: readonly string[];
  lessonMinutes: readonly number[];
  /** Today at the venue and the days after it, `YYYY-MM-DD`. */
  days: readonly string[];
}

export interface LessonPick {
  linkId: string;
  sport: string;
  minutes: number;
  day: string;
  /** RFC 3339 UTC without fractional seconds, as the times DTO writes it. */
  start: string | null;
  /** Open the confirmation sheet at once: a sign-in round trip came back. */
  confirm: boolean;
}

function one(v: string | string[] | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The URL's pick, validated against what the coach offers. Every value is a
 * HINT: one that is not among the coach's venues, that venue's sports, its
 * lengths or its days falls back to the first, and the start is applied only
 * if the day's times still offer it. Nothing here is used as a destination.
 */
export function parseLessonPick(
  sp: Record<string, string | string[] | undefined>,
  venues: readonly PickableVenue[],
): LessonPick | null {
  const first = venues[0];
  if (!first) return null;
  const venue = venues.find((v) => v.linkId === one(sp.at)) ?? first;

  const sportRaw = one(sp.sport);
  const sport = sportRaw && venue.sports.includes(sportRaw) ? sportRaw : (venue.sports[0] ?? '');

  const minRaw = Number(one(sp.min));
  const minutes = venue.lessonMinutes.includes(minRaw) ? minRaw : (venue.lessonMinutes[0] ?? 0);

  const dayRaw = one(sp.day);
  const day = dayRaw && venue.days.includes(dayRaw) ? dayRaw : (venue.days[0] ?? '');

  const startMs = Date.parse(one(sp.start) ?? '');
  const start = Number.isNaN(startMs)
    ? null
    : new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    linkId: venue.linkId,
    sport,
    minutes,
    day,
    start,
    confirm: one(sp.confirm) === '1' && start !== null,
  };
}

/**
 * The coach page's own URL for a pick. Built from the coach's page address
 * and values the page itself holds, never from anything the visitor typed, so
 * it is safe to hand to /login as `next` (which checks it again regardless).
 */
export function lessonPagePath(
  coachSlug: string,
  pick: Omit<LessonPick, 'confirm' | 'start'> & { start?: string | null; confirm?: boolean },
): string {
  const q = new URLSearchParams({ at: pick.linkId, day: pick.day, min: String(pick.minutes) });
  if (pick.sport) q.set('sport', pick.sport);
  if (pick.start) {
    q.set('start', pick.start);
    if (pick.confirm) q.set('confirm', '1');
  }
  return `${coachPath(coachSlug)}?${q.toString()}`;
}
