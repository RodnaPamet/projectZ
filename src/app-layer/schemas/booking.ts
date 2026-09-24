import { z } from 'zod';

import { MAX_BOOKING_HOURS } from '@/lib/db/booking-invariants';

import { cuidSchema } from './common';

/**
 * NOT IMPORTED BY ANYTHING. Scaffolding from P06 that the real route, which
 * arrived ~100 PRs later, never referenced.
 *
 * The comment here used to say the booking span is validated in THREE places
 * — this schema, `assertBookingSpanValid()`, and the `booking_span_valid`
 * CHECK constraint. It is two. Layer (1) never runs on any request: the route
 * hand-rolls its validation with `requireString`/`requireInstant`.
 *
 * ═══ DO NOT "RESTORE" THIS BY IMPORTING IT ═══
 *
 * That reads like the fix and would break the published contract in four
 * ways. The permissive behaviour is deliberate and DOCUMENTED:
 * openapi/playerz-v1.json types `Idempotency-Key` with `minLength: 1` and
 * calls a UUID merely "the expected form", says of `notes` that "no length
 * limit is enforced at this route", and names the field `resourceId` —
 * where this schema says `courtId`. openapi/NOTES.md explains the
 * non-strictness as a choice, because describing a strictness the server does
 * not have is worse than describing none.
 *
 * So this is dead code with a false comment, not a validation bypass. The two
 * rules it declares and nobody enforces — `notes` max 2000 and a UUID
 * idempotency key — are unenforced BY DESIGN today. Tightening either is a
 * contract change that starts with the spec, not with this file.
 *
 * Kept rather than deleted: five sibling schema modules are in the same state
 * and they form a closed island, so removing one at a time is churn. See
 * tests/guardrails/usecase-reachability.test.ts for the policy.
 */
export const createBookingSchema = z
  .object({
    courtId: cuidSchema,
    startTs: z.coerce.date(),
    endTs: z.coerce.date(),
    participants: z
      .array(
        z.object({
          userId: cuidSchema.optional(),
          guestName: z.string().min(1).max(120).optional(),
          guestEmail: z.string().email().optional(),
        }),
      )
      .max(20)
      .default([]),
    /// Client-generated. The difference between a flaky network and a
    /// double charge.
    idempotencyKey: z.string().uuid(),
    guestContact: z
      .object({
        name: z.string().min(1).max(120),
        email: z.string().email(),
        phone: z.string().min(5).max(32).optional(),
      })
      .optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((b) => b.endTs > b.startTs, {
    message: 'A booking must end after it starts.',
    path: ['endTs'],
  })
  .refine((b) => b.endTs.getTime() - b.startTs.getTime() <= MAX_BOOKING_HOURS * 3_600_000, {
    message: `A booking may not exceed ${MAX_BOOKING_HOURS} hours.`,
    path: ['endTs'],
  });

// NOTE: "a booking must be attributable to someone" (an authenticated user
// OR guest contact details) is deliberately NOT enforced here. Whether the
// caller is signed in lives in the RequestContext, not in the request body,
// and a schema cannot see it. P09's createBooking use case owns that rule —
// putting a half-version of it here would give a false sense that the input
// is fully validated.

export const cancelBookingSchema = z.object({
  bookingId: cuidSchema,
  reason: z.string().max(500).optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
