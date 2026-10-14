/**
 * A booking's result as the API sends it (#575): `GET /me/bookings/{id}/result`
 * and the club's `/admin/results`. Plain JSON, so the screens and the use case
 * that fills the first paint agree on it.
 */
export type ResultStatusDto = 'REPORTED' | 'CONFIRMED' | 'REJECTED' | 'DECIDED' | 'VOIDED';

/** How a sport's score is entered (`@/lib/ranking/score`). */
export type ResultFormatDto = 'PERIODS' | 'TOTAL' | 'ORDER' | 'NONE';

export interface ResultPlayerDto {
  userId: string;
  /** Null for a deleted account, or one with no name. */
  name: string | null;
  /** The account was deleted (#582): «Изтрит потребител». */
  deleted: boolean;
}

export interface ResultViewDto {
  id: string;
  status: ResultStatusDto;
  sides: ResultPlayerDto[][];
  score: number[][] | null;
  winnerSide: number | null;
  reportedByMe: boolean;
  reportedAt: string;
  autoConfirmAt: string | null;
  canAnswer: boolean;
}

export interface BookingResultDto {
  result: ResultViewDto | null;
  canReport: boolean;
  reportableUntil: string | null;
  format: ResultFormatDto;
  players: ResultPlayerDto[];
}

export interface ClubResultDto {
  id: string;
  bookingId: string;
  status: ResultStatusDto;
  sport: string;
  format: ResultFormatDto;
  startTs: string;
  courtName: string;
  sides: ResultPlayerDto[][];
  score: number[][] | null;
  winnerSide: number | null;
  rejectNote: string | null;
  reportedAt: string;
}

export interface ClubBookingResultDto {
  result: ClubResultDto | null;
  canEnter: boolean;
  format: ResultFormatDto;
  players: ResultPlayerDto[];
}

/** What a report, or the club's entry or correction, sends. */
export interface ResultDraft {
  sides: string[][];
  score: number[][];
}
