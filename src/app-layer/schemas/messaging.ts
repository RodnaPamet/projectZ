import { z } from 'zod';

import { BODY_VALIDATOR_MAX } from '@/lib/messaging/limits';

/**
 * Request shapes for messaging (#375). Shape only: how long a message may be
 * AFTER sanitising, who may write to whom, whether a request is waiting —
 * those rules live in `usecases/messaging.ts`, the same for every client.
 * `.strict()`: an unknown key is a 400 naming it.
 */

/** cuid-shaped: no NUL, no whitespace, nothing Postgres would refuse as a 500. */
export const messagingIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/**
 * `POST …/messages`. Bounded GENEROUSLY here: the use case measures after
 * sanitising, against `MAX_BODY_LENGTH` (4000). A validator at 4000 would
 * refuse first with a generic 400 and make `MESSAGE_TOO_LONG` unreachable —
 * the very code a client switches on (agri-saas #1391).
 */
export const sendMessageBodySchema = z
  .object({ body: z.string().min(1).max(BODY_VALIDATOR_MAX) })
  .strict();

/**
 * `POST /api/v1/me/conversations`: a player by id, a club by its slug, or a
 * player on one of the caller's bookings by their place on it — the booker
 * (`participantId: null`) or an added player — so the booking's player list
 * never has to carry a user id.
 */
export const openConversationBodySchema = z.union([
  z.object({ playerId: messagingIdSchema }).strict(),
  z.object({ club: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict(),
  z.object({ bookingId: messagingIdSchema, participantId: messagingIdSchema.nullable() }).strict(),
]);

/** `POST /api/v1/t/{slug}/admin/conversations`: a player on the club's list. */
export const openClubConversationBodySchema = z.object({ playerId: messagingIdSchema }).strict();

/** `Idempotency-Key`: optional on a send, at most 128 characters. */
export const idempotencyKeySchema = z.string().trim().min(1).max(128);
