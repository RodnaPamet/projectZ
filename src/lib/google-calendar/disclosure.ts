import { translateFor } from '@/lib/i18n/server-messages';

/**
 * What a person reads before connecting Google Calendar (#713).
 *
 * Google's Workspace user-data policy wants the disclosure IN the product,
 * right before consent, with an affirmative action: the dialog in front of
 * «Синхронизирай с Google Календар», whose «Свържи» starts Google's consent.
 * The words are the privacy policy's calendar section (content/legal/{bg,en}/
 * privacy.md, section 8), shortened.
 *
 * One text for both clients: the web renders `profile.calendar.disclosure.*`
 * from the catalogue, and `GET /api/v1/me/calendar` sends the same keys to the
 * phone. Connecting names the version the person saw, and the connection keeps
 * it, so we can show which words someone agreed to.
 *
 * Change a word → change the version (tests/unit/google-calendar/disclosure
 * pins the text to it). A client that sends an older version gets 409
 * GOOGLE_CALENDAR_DISCLOSURE_OUTDATED and shows the new text first.
 */
export const GOOGLE_CALENDAR_DISCLOSURE_VERSION = '2026-11-26';

/** The points, in the order they are shown. */
export const GOOGLE_CALENDAR_DISCLOSURE_POINTS = [
  'created',
  'freeBusy',
  'coPlayers',
  'assistant',
  'off',
] as const;

export interface GoogleCalendarDisclosure {
  version: string;
  title: string;
  points: string[];
  connect: string;
  cancel: string;
}

const KEY = 'profile.calendar.disclosure';

/** The disclosure in `locale`, for `GET /api/v1/me/calendar`. */
export async function googleCalendarDisclosure(locale: unknown): Promise<GoogleCalendarDisclosure> {
  const t = (k: string) => translateFor(locale, `${KEY}.${k}`);
  const [title, connect, cancel, ...points] = await Promise.all([
    t('title'),
    t('connect'),
    t('cancel'),
    ...GOOGLE_CALENDAR_DISCLOSURE_POINTS.map(t),
  ]);
  return { version: GOOGLE_CALENDAR_DISCLOSURE_VERSION, title, points, connect, cancel };
}
