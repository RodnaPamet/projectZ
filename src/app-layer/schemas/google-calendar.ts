import { z } from 'zod';

/**
 * `POST /api/v1/me/calendar/google/connect` (owner 2026-11-14): which client
 * is starting the consent, so the callback knows where to send the person
 * back, and which disclosure the person agreed to with «Свържи» (#713; the
 * `disclosure.version` from `GET /me/calendar`). `.strict()`: an unknown key
 * is a 400 naming it.
 */
export const googleCalendarConnectBodySchema = z
  .object({
    client: z.enum(['ios', 'web']),
    disclosureVersion: z.string().min(1).max(40),
  })
  .strict();
