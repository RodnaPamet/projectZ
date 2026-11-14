import { z } from 'zod';

/**
 * The body of `POST /api/v1/assistant/stream` (owner 2026-11-14, #704).
 *
 * `.strict()` throughout: an unknown field is a 400, never a free-text channel
 * into the prompt.
 *
 * `page` says which screen the person asked from, as IDENTIFIERS only
 * (agri-saas `PageContextSchema`): a closed set of screen names and record
 * ids. Never prose: a page cannot carry a sentence to the model. The ids are
 * not capabilities either — every tool reads through the asker's own scope,
 * so a foreign or invented id discloses nothing.
 *
 * `location` is where the app says the person is, for "near me". It never
 * reaches the model: `find_free_places` reads it from the request when the
 * model asks for `near`.
 */
export const ASSISTANT_SCREENS = [
  'home',
  'venues',
  'venue',
  'bookings',
  'booking',
  'games',
  'game',
  'profile',
  'messages',
  'other',
] as const;

export const RECORD_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not a record id');

export const AssistantPageSchema = z
  .object({
    screen: z.enum(ASSISTANT_SCREENS),
    venueId: RECORD_ID.optional(),
    bookingId: RECORD_ID.optional(),
    gameId: RECORD_ID.optional(),
  })
  .strict();

export type AssistantPage = z.infer<typeof AssistantPageSchema>;

export const ASSISTANT_MESSAGE_MAX = 2000;

export const AssistantAskSchema = z
  .object({
    message: z.string().trim().min(1).max(ASSISTANT_MESSAGE_MAX),
    conversationId: RECORD_ID.optional(),
    page: AssistantPageSchema.optional(),
    location: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .optional(),
  })
  .strict();

export type AssistantAsk = z.infer<typeof AssistantAskSchema>;
