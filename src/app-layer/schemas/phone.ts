import { z } from 'zod';

/**
 * Request bodies of the phone step (#500): `POST /me/phone/start` and
 * `POST /me/phone/confirm`.
 *
 * The number is taken as typed ("0888 123 456", "+359 88 812 3456") and
 * normalised by the use case (`normalizePhone`), which answers 400
 * PHONE_INVALID for what is not one. The schema only bounds it, so a
 * megabyte of digits never reaches a regular expression.
 */
const typedPhone = z.string().trim().min(3).max(40);

export const phoneStartBodySchema = z.object({ phone: typedPhone }).strict();

export const phoneConfirmBodySchema = z
  .object({
    phone: typedPhone,
    /** The digits from the SMS. Spaces between them are how people read a code out. */
    code: z
      .string()
      .transform((v) => v.replace(/\s+/g, ''))
      .pipe(z.string().regex(/^\d{4,10}$/)),
  })
  .strict();
