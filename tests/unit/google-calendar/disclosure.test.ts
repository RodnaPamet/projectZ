import { createHash } from 'node:crypto';

import {
  GOOGLE_CALENDAR_DISCLOSURE_POINTS,
  GOOGLE_CALENDAR_DISCLOSURE_VERSION,
  googleCalendarDisclosure,
} from '@/lib/google-calendar/disclosure';

import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * The words before «Свържи» (#713) are a record of what someone agreed to: the
 * connection stores the version. Changing a word without a new version would
 * make that record lie, so the text is pinned to the version here.
 *
 * Changed the text on purpose? Set a new GOOGLE_CALENDAR_DISCLOSURE_VERSION
 * and put the new fingerprint below. Keep the privacy policy in step.
 */
const PINNED: Record<string, string> = {
  '2026-11-26': 'e6e1d895a289e5ac',
};

const texts = () => ({
  bg: bg.profile.calendar.disclosure,
  en: en.profile.calendar.disclosure,
});

describe('Google Calendar disclosure (#713)', () => {
  it('the text matches its version', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(texts()))
      .digest('hex')
      .slice(0, 16);
    expect(PINNED[GOOGLE_CALENDAR_DISCLOSURE_VERSION]).toBe(fingerprint);
  });

  it('names what the policy requires, in both languages', () => {
    const { bg: b, en: e } = texts();
    expect(b.created).toContain('playerz');
    expect(b.assistant).toContain('Anthropic');
    expect(b.off).toContain('Профил');
    expect(e.assistant).toContain('may not use it for anything else');
    expect(b.connect).toBe('Свържи');
    expect(b.cancel).toBe('Отказ');
  });

  it('the API sends the same words, in the asked language', async () => {
    const d = await googleCalendarDisclosure('en');
    expect(d).toEqual({
      version: GOOGLE_CALENDAR_DISCLOSURE_VERSION,
      title: en.profile.calendar.disclosure.title,
      points: GOOGLE_CALENDAR_DISCLOSURE_POINTS.map((k) => en.profile.calendar.disclosure[k]),
      connect: 'Connect',
      cancel: 'Cancel',
    });
    expect((await googleCalendarDisclosure('xx')).title).toBe(bg.profile.calendar.disclosure.title);
  });
});
