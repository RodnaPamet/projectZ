import { isApiClientError } from '@/lib/data/errors';

/** What the Игри screens (#376) show for a refusal, by the server's code. */

/** The refusals a person can be shown, by the server's code; anything else is FAILED. */
export const OPEN_PLAY_ERRORS = [
  'GAME_FULL',
  'GAME_CLOSED',
  'GAME_NOT_FOUND',
  'OPEN_PLAY_CUTOFF_PASSED',
  'ASK_DECLINED',
  'ALREADY_PLAYING',
  'PLAYER_ACCOUNT_REQUIRED',
  'ACCOUNT_KIND_REQUIRED',
  'NO_SHOW_BLOCKED',
  'RATE_LIMITED',
  'REQUEST_NOT_PENDING',
  'SPOTS_UNAVAILABLE',
  'BOOKING_FULL',
  'NOTE_TOO_LONG',
] as const;

export type OpenPlayErrorKey = (typeof OPEN_PLAY_ERRORS)[number] | 'FAILED';

export function openPlayErrorKey(e: unknown): OpenPlayErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  return (OPEN_PLAY_ERRORS as readonly string[]).includes(e.code)
    ? (e.code as OpenPlayErrorKey)
    : 'FAILED';
}
