import { isSportKey } from '@/lib/sports/registry';

/**
 * Игри's URL (#376): `?tab=mine` is «Моите заявки»; `sport`, `date`
 * (YYYY-MM-DD at the venue) and `city` filter the open games. Cleaned the same
 * way on the server and in the browser, so the seed and the first client key
 * agree.
 */

export type GamesTab = 'open' | 'mine';

export const GAMES_TABS: readonly GamesTab[] = ['open', 'mine'];

export function gamesTabFrom(raw: string | string[] | null | undefined): GamesTab {
  return raw === 'mine' ? 'mine' : 'open';
}

export type GameFilters = Partial<Record<'sport' | 'date' | 'city', string>>;

export const GAME_FILTER_NAMES = ['sport', 'date', 'city'] as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function gameFiltersFromParams(
  params: { get(name: string): string | null | undefined } | null,
): GameFilters {
  const out: GameFilters = {};
  for (const k of GAME_FILTER_NAMES) {
    const v = params?.get(k)?.trim() ?? '';
    if (v === '') continue;
    if (k === 'sport' && !isSportKey(v)) continue;
    if (k === 'date' && !ISO_DAY.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The next `count` calendar days in `timeZone`, today first, as YYYY-MM-DD.
 * Today is read in the zone; the rest are counted on the calendar, not by
 * adding 24 hours, which a change of clocks would push onto the wrong day.
 */
export function nextDays(now: Date, timeZone: string, count: number): string[] {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = today.split('-').map((n) => Number.parseInt(n, 10));
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10),
  );
}
