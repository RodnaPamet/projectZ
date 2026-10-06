import { z } from 'zod';

import { MARK_READ_MAX } from '@/app-layer/usecases/my-notifications';

/**
 * Bodies of the bell's writes (#367). `.strict()`: an unknown key is a 400
 * naming it, never silently ignored.
 */

/** cuid-shaped: no NUL, no whitespace, nothing Postgres would refuse as a 500. */
export const notificationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** `POST /api/v1/me/notifications/read`: some ids, or `all: true`. */
export const markReadBodySchema = z.union([
  z.object({ ids: z.array(notificationIdSchema).min(1).max(MARK_READ_MAX) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

/** `PATCH /api/v1/me/notification-settings`: any of the three, at least one. */
export const notificationSettingsPatchSchema = z
  .object({
    email: z
      .object({
        confirmation: z.boolean().optional(),
        reminder: z.boolean().optional(),
        clubChanges: z.boolean().optional(),
      })
      .strict()
      .refine((e) => Object.keys(e).length > 0, { message: 'Set at least one category' }),
  })
  .strict();
