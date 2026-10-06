import { z } from 'zod';

/**
 * The body of `POST /api/v1/t/{slug}/bookings` (#354).
 *
 * This file used to hold P06 scaffolding that nothing imported — a schema with
 * `courtId`, participants and a UUID idempotency key in the BODY — while the
 * route hand-rolled its own checks and let `notes` through with no length cap.
 * It is now the one the route parses, and it describes the contract the spec
 * publishes (openapi/playerz-v1.json, `CreateBookingRequest`):
 *
 *   - `resourceId`: which court. A string; an unknown or foreign id is a 404
 *     from the route, as before, rather than a 400 that confirms the format.
 *   - `startTs`, `endTs`: RFC 3339 instants with an offset. Whether the span is
 *     bookable — hours, step grid, units, the future — is `quoteBooking`'s and
 *     the route's to say, with SLOT_NOT_BOOKABLE.
 *   - `notes`: optional, at most {@link MAX_BOOKING_NOTES} characters. A note
 *     that is not a string is now a 400; it used to be dropped silently.
 *
 * NOT `.strict()`. Unknown properties are ignored, as they always were — a
 * client sending `totalCents` is ignored rather than refused, and the route's
 * tests pin that the price is never the client's.
 *
 * The idempotency key is a HEADER and is checked by the route.
 */
export const MAX_BOOKING_NOTES = 500;

export const createBookingBodySchema = z.object({
  resourceId: z.string().trim().min(1).max(64),
  startTs: z.iso.datetime({ offset: true }),
  endTs: z.iso.datetime({ offset: true }),
  notes: z.string().trim().max(MAX_BOOKING_NOTES).nullish(),
});

export type CreateBookingBody = z.infer<typeof createBookingBodySchema>;

/**
 * `when` on `GET /api/v1/me/bookings` (#359): the Предстоящи and Минали tabs.
 * Absent means every booking, newest first, as the list was before the tabs;
 * anything else is a 400 naming the field, not a silent fallback that would
 * show a past game under "upcoming".
 */
export const bookingWhenSchema = z.enum(['upcoming', 'past']).optional();
