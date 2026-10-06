import { z } from 'zod';

import { normalizePhone } from '@/lib/booking/phone';
import { MAX_SERIES_WEEKS } from '@/lib/booking/weekly';

import { MAX_BOOKING_NOTES } from './booking';

/**
 * The bodies of the desk-booking and booking-series routes (#364).
 *
 * ═══ THE TIME IS THE CLUB'S WALL CLOCK, NOT AN INSTANT ═══
 *
 * The player route takes `startTs`/`endTs` instants, because a player picks a
 * slot the availability endpoint already resolved. The desk types "Tuesday,
 * 19:00, an hour" — and for a series that is the RULE: every Tuesday at 19:00
 * on the club's clock, which is a different UTC instant either side of the
 * October DST change. So these bodies carry `date` + `startTime` +
 * `durationMinutes`, and the server resolves each occurrence in the venue's
 * timezone. A client never does timezone arithmetic.
 *
 * ═══ .strict(), ON PURPOSE ═══
 *
 * Unlike the player booking body, an unknown property is a 400. These are
 * staff writes that set a price; a typo like `price` instead of `priceCents`
 * must not silently book at the quote.
 */

/** Longest single desk booking. A court is not hired for more than a day. */
export const MAX_DESK_DURATION_MINUTES = 720;
/** A price staff may type, in cents: €10 000 is a typo, not a court. */
export const MAX_DESK_PRICE_CENTS = 1_000_000;
export const MAX_CUSTOMER_NAME = 80;

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** `YYYY-MM-DD` that is also a real calendar day (no 2026-02-30). */
export const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
  }, 'Not a calendar date');

export const wallTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm (24-hour)');

const customerNameSchema = z
  .string()
  .transform((s) => s.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(MAX_CUSTOMER_NAME)
      // No control or format characters: this is printed on the diary.
      .regex(/^[^\p{C}]+$/u, 'No control characters'),
  );

/** A phone, normalised to E.164 (`+359888123456`), or a 400. */
export const phoneSchema = z
  .string()
  .max(32)
  .transform((s, ctx) => {
    const e164 = normalizePhone(s);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Not a phone number' });
      return z.NEVER;
    }
    return e164;
  });

export const deskCustomerSchema = z
  .object({
    name: customerNameSchema,
    phone: phoneSchema,
    /**
     * A playerz account to link, chosen from the club's own players. Null or
     * absent: a customer with no account.
     */
    userId: z.string().trim().min(1).max(64).nullish(),
  })
  .strict();

export type DeskCustomer = z.infer<typeof deskCustomerSchema>;

const slotShape = {
  resourceId: z.string().trim().min(1).max(64),
  date: isoDateSchema,
  startTime: wallTimeSchema,
  durationMinutes: z.number().int().min(15).max(MAX_DESK_DURATION_MINUTES),
};

/** Until a date, or for N weeks — exactly one. */
export const repeatSchema = z
  .object({
    weeks: z.number().int().min(1).max(MAX_SERIES_WEEKS).optional(),
    until: isoDateSchema.optional(),
  })
  .strict()
  .refine((r) => (r.weeks === undefined) !== (r.until === undefined), {
    message: 'Give exactly one of `weeks` or `until`',
  });

export type Repeat = z.infer<typeof repeatSchema>;

const priceSchema = z.number().int().min(0).max(MAX_DESK_PRICE_CENTS).nullish();
const notesSchema = z.string().trim().max(MAX_BOOKING_NOTES).nullish();

/** `GET /admin/desk-bookings/preview` (from the query): what it would cost, and what clashes. */
export const deskPreviewSchema = z
  .object({ ...slotShape, repeat: repeatSchema.optional() })
  .strict();

/** `POST /admin/desk-bookings`: one booking. */
export const createDeskBookingBodySchema = z
  .object({
    ...slotShape,
    customer: deskCustomerSchema,
    /** Staff's price for it; absent or null is the server's quote. */
    priceCents: priceSchema,
    notes: notesSchema,
  })
  .strict();

/** `POST /admin/booking-series`: a weekly series. */
export const createSeriesBodySchema = z
  .object({
    ...slotShape,
    repeat: repeatSchema,
    customer: deskCustomerSchema,
    priceCents: priceSchema,
    notes: notesSchema,
    /** Occurrences the desk chose to leave out — the clashes it was shown. */
    skipDates: z.array(isoDateSchema).max(MAX_SERIES_WEEKS).optional(),
  })
  .strict();

/** `PATCH /admin/desk-bookings/{id}`: the customer, the notes. */
export const updateDeskBookingBodySchema = z
  .object({
    customer: deskCustomerSchema.optional(),
    notes: notesSchema,
    /**
     * For an occurrence of a series: change this one AND every later live
     * occurrence, and the series itself. Ignored for a booking with no series.
     */
    applyToSeries: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.customer !== undefined || b.notes !== undefined, {
    message: 'Nothing to change',
  });

/** `POST /admin/booking-series/{id}/cancel`. */
export const cancelSeriesBodySchema = z
  .object({
    /** The first club-local day to cancel; every live occurrence from it on goes. */
    fromDate: isoDateSchema,
    reason: z.string().trim().max(MAX_BOOKING_NOTES).optional(),
  })
  .strict();

export type DeskPreviewInput = z.infer<typeof deskPreviewSchema>;
export type CreateDeskBookingBody = z.infer<typeof createDeskBookingBodySchema>;
export type CreateSeriesBody = z.infer<typeof createSeriesBodySchema>;
export type UpdateDeskBookingBody = z.infer<typeof updateDeskBookingBodySchema>;
