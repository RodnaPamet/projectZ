import { z } from 'zod';

/**
 * `POST /api/v1/me/calendar/google/connect` (owner 2026-11-14): which client
 * is starting the consent, so the callback knows where to send the person
 * back. `.strict()`: an unknown key is a 400 naming it.
 */
export const googleCalendarConnectBodySchema = z
  .object({ client: z.enum(['ios', 'web']) })
  .strict();
