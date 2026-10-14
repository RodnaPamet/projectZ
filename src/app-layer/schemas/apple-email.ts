import { z } from 'zod';

/**
 * Request bodies of Sign in with Apple's hidden-address step (#442):
 * `POST /auth/apple/email` and `POST /auth/apple/confirm`.
 *
 * The address is taken as typed and checked by the use case
 * (`apple-sign-in.ts`), which answers 400 EMAIL_INVALID or EMAIL_IS_RELAY.
 * The schema only bounds the strings.
 */
export const appleEmailBodySchema = z
  .object({
    /** What the `apple` grant answered with, in `error.details.ticket`. */
    ticket: z.string().min(16).max(4096),
    email: z.string().trim().min(3).max(254),
  })
  .strict();

export const appleConfirmBodySchema = z
  .object({
    /** What `/auth/apple/email` answered with. */
    challenge: z.string().min(16).max(4096),
    /** The digits from the email. Spaces between them are how people read a code out. */
    code: z
      .string()
      .transform((v) => v.replace(/\s+/g, ''))
      .pipe(z.string().regex(/^\d{4,10}$/)),
  })
  .strict();
