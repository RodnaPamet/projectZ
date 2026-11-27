import { resolveLocale } from '@/lib/i18n/locales';
import { legalHrefs } from '@/lib/legal/texts';
import { translateFor } from '@/lib/i18n/server-messages';
import { OBJECTION_ADDRESS, type ReviewRefusal } from '@/lib/moderation/refusal';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * The words of the notice about a refused review (#714): the statement of
 * reasons the EU Digital Services Act (Art. 17) and the terms of use
 * (section 10, «Мотиви») promise. It says
 *
 *   what was done   not published, or removed
 *   why             the rule, in plain words (`RefusalReason`)
 *   who decided     the AI check, or a moderator
 *   how to object   privacy@playerz.bg for a person's second look, the
 *                   regulators (КРС, КЗП), or the courts
 *
 * The bell carries the short form; the email the whole of it.
 */

/** What the review was about. */
export type ReviewTarget =
  { kind: 'venue'; venue: string } | { kind: 'coach'; coach: string | null };

/** Where the bell and the email point: the author's bookings, where their reviews show. */
export const REVIEW_REFUSED_HREF = '/me/bookings?tab=past';

/** One line: nothing typed into a name can add a header or a line. */
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

async function targetText(locale: 'bg' | 'en', target: ReviewTarget): Promise<string> {
  if (target.kind === 'venue') {
    return translateFor(locale, 'notifications.review.venue', { venue: oneLine(target.venue) });
  }
  return target.coach?.trim()
    ? translateFor(locale, 'notifications.review.coach', { coach: oneLine(target.coach) })
    : translateFor(locale, 'notifications.review.coachUnnamed');
}

const reasonText = (locale: 'bg' | 'en', refusal: ReviewRefusal) =>
  translateFor(locale, `myBookings.review.refusal.reason.${refusal.reason}`);

export async function reviewRefusedBellCopy(
  rawLocale: unknown,
  refusal: ReviewRefusal,
  target: ReviewTarget,
): Promise<{ title: string; body: string }> {
  const locale = resolveLocale(rawLocale);
  const [title, targetLine, reason, who] = await Promise.all([
    translateFor(
      locale,
      refusal.action === 'REMOVED'
        ? 'notifications.review.removed'
        : 'notifications.review.notPublished',
    ),
    targetText(locale, target),
    reasonText(locale, refusal),
    translateFor(
      locale,
      refusal.automated
        ? 'myBookings.review.refusal.automated'
        : 'myBookings.review.refusal.moderator',
    ),
  ]);
  const body = await translateFor(locale, 'notifications.review.body', {
    target: targetLine,
    reason,
    who,
    email: OBJECTION_ADDRESS,
  });
  return { title: oneLine(title), body: oneLine(body) };
}

export async function reviewRefusedEmail(
  rawLocale: unknown,
  refusal: ReviewRefusal,
  target: ReviewTarget,
): Promise<{ subject: string; text: string }> {
  const locale = resolveLocale(rawLocale);
  const action = refusal.action === 'REMOVED' ? 'removed' : 'notPublished';
  const [targetLine, reason] = await Promise.all([
    targetText(locale, target),
    reasonText(locale, refusal),
  ]);
  // The terms' address only while their text is there (legal-pages guardrail).
  const termsHref = (await legalHrefs(locale)).terms;
  const [subject, intro, why, lTerms, how, objectTitle, objectUs, objectOthers, lLink, footer] =
    await Promise.all([
      translateFor(locale, `emails.review.${action}.subject`),
      translateFor(locale, `emails.review.${action}.intro`, { target: targetLine }),
      translateFor(locale, 'emails.review.why', { reason }),
      translateFor(locale, 'emails.review.terms'),
      translateFor(
        locale,
        refusal.automated ? 'emails.review.automated' : 'emails.review.moderator',
      ),
      translateFor(locale, 'emails.review.objectTitle'),
      translateFor(locale, 'emails.review.objectUs', { email: OBJECTION_ADDRESS }),
      translateFor(locale, 'emails.review.objectOthers'),
      translateFor(locale, 'emails.review.link'),
      translateFor(locale, 'emails.review.footer'),
    ]);
  const text = [
    intro,
    '',
    why,
    ...(termsHref ? [`${lTerms}: ${absoluteUrl(termsHref)}`] : []),
    '',
    how,
    '',
    objectTitle,
    `- ${objectUs}`,
    `- ${objectOthers}`,
    '',
    `${lLink}: ${absoluteUrl(REVIEW_REFUSED_HREF)}`,
    '',
    '—',
    footer,
  ].join('\n');
  return { subject: oneLine(subject), text };
}
