import { resolveLocale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';

/**
 * The words of a result's notifications (#575): to the other side when a
 * result is reported, to the club's staff when it is disputed, to the players
 * when the club decides it. Bell and email, in each reader's language.
 */

/** One line: nothing a name or a venue holds can add a header or a line. */
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

/** «6:4 3:6 7:5»: each set side 0 first, as the reporter's sides are. */
export function formatScore(score: ReadonlyArray<ReadonlyArray<number>>): string {
  return score.map(([a, b]) => `${a}:${b}`).join(' ');
}

export interface ResultFacts {
  /** The venue's name. */
  venue: string;
  /** When the booking was, as the reader reads a day: «14 окт.». */
  day: string;
  /** The score as reported, or as the club decided it. */
  score: string;
}

export async function resultReportedCopy(
  rawLocale: unknown,
  facts: ResultFacts & { reporter: string; deadline: string },
  href: string,
): Promise<{ title: string; body: string; subject: string; text: string }> {
  const locale = resolveLocale(rawLocale);
  const v = { ...facts };
  const [title, body, subject, intro, link] = await Promise.all([
    translateFor(locale, 'notifications.result.reported.title', v),
    translateFor(locale, 'notifications.result.reported.body', v),
    translateFor(locale, 'emails.result.reported.subject', v),
    translateFor(locale, 'emails.result.reported.intro', v),
    translateFor(locale, 'emails.result.link'),
  ]);
  return {
    title,
    body,
    subject: oneLine(subject),
    text: [intro, '', `${link}: ${href}`].join('\n'),
  };
}

export async function resultDisputedCopy(
  rawLocale: unknown,
  facts: ResultFacts,
  href: string,
): Promise<{ title: string; body: string; subject: string; text: string }> {
  const locale = resolveLocale(rawLocale);
  const [title, body, subject, intro, link] = await Promise.all([
    translateFor(locale, 'notifications.result.disputed.title', { ...facts }),
    translateFor(locale, 'notifications.result.disputed.body', { ...facts }),
    translateFor(locale, 'emails.result.disputed.subject', { ...facts }),
    translateFor(locale, 'emails.result.disputed.intro', { ...facts }),
    translateFor(locale, 'emails.result.clubLink'),
  ]);
  return {
    title,
    body,
    subject: oneLine(subject),
    text: [intro, '', `${link}: ${href}`].join('\n'),
  };
}

export async function resultDecidedCopy(
  rawLocale: unknown,
  facts: ResultFacts,
  voided: boolean,
): Promise<{ title: string; body: string }> {
  const locale = resolveLocale(rawLocale);
  const [title, body] = await Promise.all(
    voided
      ? [
          translateFor(locale, 'notifications.result.voided.title', { ...facts }),
          translateFor(locale, 'notifications.result.voided.body', { ...facts }),
        ]
      : [
          translateFor(locale, 'notifications.result.decided.title', { ...facts }),
          translateFor(locale, 'notifications.result.decided.body', { ...facts }),
        ],
  );
  return { title, body };
}
