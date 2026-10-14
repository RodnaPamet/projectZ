import type { ResultStatusDto } from './types';

/** A result's status as a badge (#575): waiting, counted, disputed, or void. */
export const RESULT_TONE: Record<ResultStatusDto, 'info' | 'success' | 'warning' | 'neutral'> = {
  REPORTED: 'info',
  CONFIRMED: 'success',
  REJECTED: 'warning',
  DECIDED: 'success',
  VOIDED: 'neutral',
};
