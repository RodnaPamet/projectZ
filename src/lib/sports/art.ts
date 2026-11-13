import type { SportType } from '@prisma/client';

/**
 * Each sport's banner photo (owner 2026-11-13: "use the pictures to highlight
 * each selected sport page"), the same 18 the iPhone app bundles. Served from
 * `public/sports/`. A `Record` over every sport, so a sport added to the enum
 * without a picture is a compile error.
 *
 * Illustrative category art, never a club's place: a club's own photo always
 * replaces it, and it is decoration (`alt=""`) beside the sport's name.
 */
const FILE: Record<SportType, string> = {
  TENNIS: 'tennis',
  PADEL: 'padel',
  BADMINTON: 'badminton',
  TABLE_TENNIS: 'table-tennis',
  BEACH_TENNIS: 'beach-tennis',
  PICKLEBALL: 'pickleball',
  SQUASH: 'squash',
  FOOTBALL5: 'football-5x5',
  FOOTBALL: 'football',
  BASKETBALL: 'basketball',
  VOLLEYBALL: 'volleyball',
  BEACH_VOLLEYBALL: 'beach-volleyball',
  HANDBALL: 'handball',
  CHESS: 'chess',
  ESPORTS: 'esports',
  KARTING: 'karting',
  RUNNING: 'running',
  CYCLING: 'cycling',
};

/** The banner's path, or null for a value this build does not know. */
export function sportArt(sport: string | null | undefined): string | null {
  if (!sport || !(sport in FILE)) return null;
  return `/sports/${FILE[sport as SportType]}.webp`;
}
