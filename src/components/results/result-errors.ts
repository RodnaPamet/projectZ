import { isApiClientError } from '@/lib/data/errors';

/** The refusals a result's screens (#575) can show, by the server's code; anything else is FAILED. */
export const RESULT_ERRORS = [
  'RESULT_NOT_REPORTABLE',
  'RESULT_ALREADY_REPORTED',
  'RESULT_NOT_AWAITING',
  'RESULT_NOT_YOURS_TO_ANSWER',
  'RESULT_NOT_FOUND',
  'INVALID_SIDES',
  'INVALID_SCORE',
  'INVALID_ORDER',
  'RATE_LIMITED',
] as const;

export type ResultErrorKey = (typeof RESULT_ERRORS)[number] | 'FAILED';

export function resultErrorKey(e: unknown): ResultErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  return (RESULT_ERRORS as readonly string[]).includes(e.code)
    ? (e.code as ResultErrorKey)
    : 'FAILED';
}
