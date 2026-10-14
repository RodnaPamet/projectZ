import { z } from 'zod';

import { sportSchema } from '@/app-layer/schemas/common';
import {
  CLUB_FORMATS,
  DRAW_SIZE_MAX,
  DRAW_SIZE_MIN,
  TOURNAMENT_DESCRIPTION_MAX,
  TOURNAMENT_NAME_MAX,
} from '@/app-layer/usecases/club-tournaments';

/**
 * Request bodies of a club's tournament (#579). The use case checks what
 * depends on the club and the clock: the venue is the club's, the start is
 * later, sign-up closes by it, Americano and Mexicano are pairs.
 */
const at = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

/** `POST` and `PUT` of `/t/{slug}/admin/tournaments[/{id}]`. */
export const tournamentBodySchema = z
  .object({
    name: z.string().trim().min(1).max(TOURNAMENT_NAME_MAX),
    sport: sportSchema,
    format: z.enum(CLUB_FORMATS),
    teamSize: z.union([z.literal(1), z.literal(2)]),
    venueId: z.string().min(1).max(64),
    startsAt: at,
    endsAt: at.nullable().optional(),
    entriesCloseAt: at.nullable().optional(),
    drawSize: z.number().int().min(DRAW_SIZE_MIN).max(DRAW_SIZE_MAX),
    entryFeeCents: z.number().int().min(0).max(1_000_000),
    feePayment: z.enum(['AT_CLUB', 'ONLINE']),
    description: z.string().max(TOURNAMENT_DESCRIPTION_MAX).nullable().optional(),
  })
  .strict();

/** `POST /tournaments/{id}/entries`: the partner, for doubles (decision 50). */
export const enterTournamentBodySchema = z
  .object({ partnerUserId: z.string().min(1).max(64).nullable().optional() })
  .strict();

/** `?city=&sport=` on the list of tournaments open for sign-up (decision 53). */
export const openTournamentsQuerySchema = z.object({
  city: z.string().trim().max(60).optional(),
  sport: sportSchema.optional(),
});

/** `POST /t/{slug}/admin/tournaments/{id}/draw` (#580; decisions 55, 61). */
export const drawBodySchema = z
  .object({
    groupCount: z.number().int().min(1).max(32).nullable().optional(),
    qualifiersPerGroup: z.number().int().min(1).max(8).nullable().optional(),
    thirdPlace: z.boolean().optional(),
  })
  .strict();

/** `POST /t/{slug}/admin/tournament-matches/{id}/schedule` (#580, decision 40). */
export const scheduleMatchBodySchema = z
  .object({
    resourceId: z.string().min(1).max(64),
    startTs: at,
    durationMinutes: z.number().int().min(15).max(480),
  })
  .strict();

/** `POST /t/{slug}/admin/tournament-matches/{id}/walkover` (#580; decisions 58, 59). */
export const walkoverBodySchema = z
  .object({ winnerSide: z.union([z.literal(0), z.literal(1)]) })
  .strict();
