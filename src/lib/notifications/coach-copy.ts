import { COACH_PROFILE_HREF, PLATFORM_COACHES_HREF } from '@/lib/coaches/hrefs';
import { absoluteUrl } from '@/lib/seo/site-url';
import { resolveLocale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';

/**
 * The words of a coach's notifications (#545): the platform's answer to a
 * profile sent for approval. Bell and email, in the coach's language; and one
 * email to the operator, in Bulgarian, when a profile arrives.
 */

/** What the platform did with a coach's profile. */
export type CoachDecisionEvent = 'approved' | 'declined' | 'removed';

export { COACH_PROFILE_HREF, PLATFORM_COACHES_HREF };

/** One line: nothing typed into a note can add a header or a label line. */
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

export async function coachBellCopy(
  rawLocale: unknown,
  event: CoachDecisionEvent,
): Promise<{ title: string; body: string }> {
  const locale = resolveLocale(rawLocale);
  const [title, body] = await Promise.all([
    translateFor(locale, `notifications.coach.${event}.title`),
    translateFor(locale, `notifications.coach.${event}.body`),
  ]);
  return { title, body };
}

/**
 * The email with a decision. A decline or a removal carries the owner's note,
 * as written (plain text, its own line breaks kept); an approval carries none.
 */
export async function coachDecisionEmail(
  rawLocale: unknown,
  event: CoachDecisionEvent,
  note: string | null,
): Promise<{ subject: string; text: string }> {
  const locale = resolveLocale(rawLocale);
  const [subject, intro, lNote, lLink, footer] = await Promise.all([
    translateFor(locale, `emails.coach.${event}.subject`),
    translateFor(locale, `emails.coach.${event}.intro`),
    translateFor(locale, 'emails.coach.note'),
    translateFor(locale, 'emails.coach.link'),
    translateFor(locale, 'emails.coach.footer'),
  ]);
  const lines = [
    intro,
    ...(event !== 'approved' && note ? ['', `${lNote}:`, note] : []),
    '',
    `${lLink}: ${absoluteUrl(COACH_PROFILE_HREF)}`,
    '',
    '—',
    footer,
  ];
  return { subject: oneLine(subject), text: lines.join('\n') };
}

/**
 * To the operator: a profile is waiting. It names nobody: the queue is where
 * the application is read, behind the grant and the second factor, and an
 * inbox is neither.
 */
export async function coachSubmittedOperatorEmail(): Promise<{ subject: string; text: string }> {
  const L = 'bg';
  const [subject, intro, lLink] = await Promise.all([
    translateFor(L, 'emails.coachSubmitted.subject'),
    translateFor(L, 'emails.coachSubmitted.intro'),
    translateFor(L, 'emails.coachSubmitted.link'),
  ]);
  return {
    subject: oneLine(subject),
    text: [intro, '', `${lLink}: ${absoluteUrl(PLATFORM_COACHES_HREF)}`, ''].join('\n'),
  };
}
