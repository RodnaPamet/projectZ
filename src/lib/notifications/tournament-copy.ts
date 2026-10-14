import { resolveLocale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';

/**
 * The words of a tournament's notices (#579): the club's desk about a new
 * entry or a withdrawal, the partner an entrant named (decision 50), both of
 * a pair about the club's answer or a cancellation. Bell, push and, where it
 * is somebody's to act on, email, in each reader's language.
 */

/** One line: nothing a name can turn into a header or a second line. */
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

export interface TournamentFacts {
  /** The tournament's name. */
  tournament: string;
  /** When it starts, as the reader reads a day: «20 окт.». */
  day: string;
  /** The venue's name. */
  venue: string;
}

export type TournamentNotice =
  | { kind: 'received'; players: string }
  | { kind: 'partner'; entrant: string }
  | { kind: 'confirmed' }
  | { kind: 'declined' }
  | { kind: 'withdrawn'; who: string }
  | { kind: 'withdrawnDesk'; players: string }
  | { kind: 'cancelled' };

/** Which notices also go by email, and under which subject key. */
const EMAILED: ReadonlySet<TournamentNotice['kind']> = new Set([
  'partner',
  'confirmed',
  'declined',
  'cancelled',
]);

export async function tournamentCopy(
  rawLocale: unknown,
  facts: TournamentFacts,
  notice: TournamentNotice,
  href: string | null,
): Promise<{ title: string; body: string; email: { subject: string; text: string } | null }> {
  const locale = resolveLocale(rawLocale);
  const v = { ...facts, ...notice };
  const [title, body] = await Promise.all([
    translateFor(locale, `notifications.tournament.${notice.kind}.title`, v),
    translateFor(locale, `notifications.tournament.${notice.kind}.body`, v),
  ]);
  if (!EMAILED.has(notice.kind) || !href) return { title, body, email: null };
  const [subject, intro, link] = await Promise.all([
    translateFor(locale, `emails.tournament.${notice.kind}.subject`, v),
    translateFor(locale, `emails.tournament.${notice.kind}.intro`, v),
    translateFor(locale, 'emails.tournament.link'),
  ]);
  return {
    title,
    body,
    email: { subject: oneLine(subject), text: [intro, '', `${link}: ${href}`].join('\n') },
  };
}
