import type { OpenGameRequestStatus, SportType } from '@prisma/client';

import type {
  BookingGameView,
  MyGameRequest,
  OpenGameSummary,
  RequestCard,
} from '@/app-layer/usecases/open-play';

/**
 * Wire shapes for open play (#376). Dates are ISO strings. What anyone sees
 * of a game (`OpenGameDto`) never carries a user id, a booking id, an email or
 * a phone; the booker's own view of their requests carries the askers' user
 * ids, which is what opening a conversation with one of them takes.
 */

export type OpenGameRequestStatusDto = OpenGameRequestStatus;

export interface OpenGameDto {
  id: string;
  sport: SportType;
  resourceType: string;
  courtName: string;
  venue: { id: string; slug: string; name: string; city: string };
  startTs: string;
  endTs: string;
  timezone: string;
  cutoffAt: string;
  capacity: number;
  playersCount: number;
  spotsLeft: number;
  open: boolean;
  levelMin: number | null;
  levelMax: number | null;
  note: string | null;
  booker: { firstName: string | null; avatarUrl: string | null };
  viewer: {
    isBooker: boolean;
    isPlaying: boolean;
    bookingId: string | null;
    request: { id: string; status: OpenGameRequestStatusDto } | null;
  } | null;
}

export function toOpenGameDto(g: OpenGameSummary): OpenGameDto {
  return {
    id: g.id,
    sport: g.sport,
    resourceType: g.resourceType,
    courtName: g.courtName,
    venue: g.venue,
    startTs: g.startTs.toISOString(),
    endTs: g.endTs.toISOString(),
    timezone: g.timezone,
    cutoffAt: g.cutoffAt.toISOString(),
    capacity: g.capacity,
    playersCount: g.playersCount,
    spotsLeft: g.spotsLeft,
    open: g.open,
    levelMin: g.levelMin,
    levelMax: g.levelMax,
    note: g.note,
    booker: g.booker,
    viewer: g.viewer,
  };
}

export interface OpenGameRequestDto {
  id: string;
  status: OpenGameRequestStatusDto;
  note: string | null;
  askedAt: string;
  decidedAt: string | null;
  participantId: string | null;
  player: {
    userId: string;
    name: string | null;
    avatarUrl: string | null;
    sports: Array<{ sport: SportType; level: number }>;
    deleted: boolean;
  };
}

function toRequestDto(r: RequestCard): OpenGameRequestDto {
  return {
    id: r.id,
    status: r.status,
    note: r.note,
    askedAt: r.askedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    participantId: r.participantId,
    player: r.player,
  };
}

/** `GET/PUT/DELETE /me/bookings/{id}/game`, and each answer to a request. */
export interface BookingGameDto {
  viewerRole: 'BOOKER' | 'PARTICIPANT';
  bookingId: string;
  sport: SportType;
  cutoffAt: string;
  canOpen: boolean;
  maxSpots: number;
  game: {
    id: string;
    open: boolean;
    closedAt: string | null;
    spotsLeft: number;
    accepted: number;
    levelMin: number | null;
    levelMax: number | null;
    note: string | null;
  } | null;
  requests: OpenGameRequestDto[];
  myRequest: { id: string; status: OpenGameRequestStatusDto } | null;
}

export function toBookingGameDto(v: BookingGameView): BookingGameDto {
  return {
    viewerRole: v.viewerRole,
    bookingId: v.bookingId,
    sport: v.sport,
    cutoffAt: v.cutoffAt.toISOString(),
    canOpen: v.canOpen,
    maxSpots: v.maxSpots,
    game: v.game
      ? {
          ...v.game,
          closedAt: v.game.closedAt?.toISOString() ?? null,
        }
      : null,
    requests: v.requests.map(toRequestDto),
    myRequest: v.myRequest,
  };
}

/** `GET /me/game-requests`: «Моите заявки». */
export interface MyGameRequestDto {
  id: string;
  status: OpenGameRequestStatusDto;
  note: string | null;
  askedAt: string;
  decidedAt: string | null;
  bookingId: string | null;
  game: OpenGameDto;
}

export function toMyGameRequestDto(r: MyGameRequest): MyGameRequestDto {
  return {
    id: r.id,
    status: r.status,
    note: r.note,
    askedAt: r.askedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    bookingId: r.bookingId,
    game: toOpenGameDto(r.game),
  };
}
