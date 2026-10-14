import { isApiClientError } from '@/lib/data/errors';

/** The refusals a tournament's screens (#579) can show, by the server's code; anything else is FAILED. */
export const TOURNAMENT_ERRORS = [
  'TOURNAMENT_NOT_FOUND',
  'TOURNAMENT_NOT_OPEN',
  'TOURNAMENT_INVALID',
  'TOURNAMENT_ONLINE_FEE_UNAVAILABLE',
  'TOURNAMENT_ALREADY_ENTERED',
  'TOURNAMENT_PARTNER_REQUIRED',
  'TOURNAMENT_PARTNER_UNAVAILABLE',
  'TOURNAMENT_DRAW_FULL',
  'TOURNAMENT_ENTRY_NOT_FOUND',
  'TOURNAMENT_ENTRY_NOT_ACTIVE',
  'TOURNAMENT_STATE',
  'PLAYER_ACCOUNT_REQUIRED',
  // A confirmed phone number first (#500): shown as PhoneRequiredNotice.
  'PHONE_REQUIRED',
  'RATE_LIMITED',
] as const;

export type TournamentErrorKey = (typeof TOURNAMENT_ERRORS)[number] | 'FAILED';

export function tournamentErrorKey(e: unknown): TournamentErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  return (TOURNAMENT_ERRORS as readonly string[]).includes(e.code)
    ? (e.code as TournamentErrorKey)
    : 'FAILED';
}
