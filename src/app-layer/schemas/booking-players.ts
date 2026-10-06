import { z } from 'zod';

/**
 * Request bodies for players on a booking (#358) and the account-kind choice
 * (#360). All `.strict()`: an unknown property is a 400 naming it, never
 * silently ignored, because each of these writes who is on a booking or what
 * an account IS.
 */

/**
 * `{ token }` for the invite preview and accept. Only the length is bounded
 * here: a token of the wrong shape is answered like a dead one (404) by the
 * use case, which refuses it before hashing, so the shape tells a prober
 * nothing the 404 does not.
 */
export const bookingInviteTokenBodySchema = z.object({ token: z.string().max(200) }).strict();

/** `POST /me/bookings/{id}/participants`: one of the caller's co-players. */
export const addParticipantBodySchema = z.object({ userId: z.string().min(1).max(64) }).strict();

/**
 * `POST /me/account-kind` (#360). PLAYER or COACH only: a CLUB account is made
 * by the owner (`create-venue-org`) or a staff invite, never chosen.
 */
export const accountKindBodySchema = z.object({ kind: z.enum(['PLAYER', 'COACH']) }).strict();

export type ChoosableAccountKind = z.infer<typeof accountKindBodySchema>['kind'];
