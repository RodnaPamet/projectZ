import { resolveLocale, type Locale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * The words of a booking notification (#367), in the RECIPIENT's language.
 *
 * Every time is the CLUB's wall clock (`venue.timezone`, Europe/Sofia for the
 * pilot), never the server's and never the reader's device: "19:00" on the
 * email is the 19:00 on the club's board, on either side of a DST change.
 *
 * Emails are plain text, short labelled lines, with no HTML part: nothing to
 * track with, nothing to inject into, and a screen reader reads it in order.
 * Links are absolute on `SITE_URL` (src/lib/seo/site-url.ts), never on the
 * host a request happened to arrive on.
 */

export interface BookingFacts {
  bookingId: string;
  venueName: string;
  courtName: string;
  startTs: Date;
  endTs: Date;
  timezone: string;
  /** Hours before the start a player may still cancel (#354). */
  cutoffHours: number;
}

const INTL: Record<Locale, string> = { bg: 'bg-BG', en: 'en-GB' };

function fmt(locale: Locale, at: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(INTL[locale], { timeZone, ...opts }).format(at);
}

/** "пт, 9 окт." */
export function formatDate(locale: Locale, at: Date, timeZone: string): string {
  return fmt(locale, at, timeZone, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "19:00", 24-hour in both languages. */
export function formatTime(locale: Locale, at: Date, timeZone: string): string {
  return fmt(locale, at, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "пт, 9 окт., 19:00–20:30" */
export function formatWhen(locale: Locale, start: Date, end: Date, timeZone: string): string {
  return `${formatDate(locale, start, timeZone)}, ${formatTime(locale, start, timeZone)}–${formatTime(locale, end, timeZone)}`;
}

/** Where a notification about a booking takes you. */
export function bookingHref(bookingId: string): string {
  return `/me/bookings/${encodeURIComponent(bookingId)}`;
}

/** One line of text: no line breaks, so a venue name cannot add lines. */
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

export type BookingBellEvent =
  | 'confirmed'
  | 'reminder'
  | 'cancelledByClub'
  | 'cancelledByBooker'
  | 'seriesCreated'
  | 'seriesCancelled'
  | 'playerJoined'
  | 'playerLeft'
  | 'playerAdded'
  | 'playerRemoved';

/** The bell's title and body. `name` is the other player, where there is one. */
export async function bellCopy(
  rawLocale: unknown,
  event: BookingBellEvent,
  facts: BookingFacts,
  extra: { name?: string | null; date?: string } = {},
): Promise<{ title: string; body: string }> {
  const locale = resolveLocale(rawLocale);
  const name = extra.name?.trim()
    ? oneLine(extra.name)
    : await translateFor(locale, 'notifications.booking.someone');
  const values = {
    venue: oneLine(facts.venueName),
    court: oneLine(facts.courtName),
    when: formatWhen(locale, facts.startTs, facts.endTs, facts.timezone),
    date: extra.date ?? formatDate(locale, facts.startTs, facts.timezone),
    name,
  };
  const [title, body] = await Promise.all([
    translateFor(locale, `notifications.booking.${event}.title`, values),
    translateFor(locale, `notifications.booking.${event}.body`, values),
  ]);
  return { title, body };
}

export type BookingEmailEvent = 'confirmed' | 'reminder' | 'cancelledByClub' | 'seriesCreated';

/**
 * A booking email. The labelled lines are the owner's list (Q22): venue,
 * court, the time in the club's zone, payment at the club, the cancellation
 * deadline, and the link. A cancellation leaves out what no longer applies.
 */
export async function bookingEmail(
  rawLocale: unknown,
  event: BookingEmailEvent,
  facts: BookingFacts,
  now: Date = new Date(),
): Promise<{ subject: string; text: string }> {
  const locale = resolveLocale(rawLocale);
  const tz = facts.timezone;
  const values = {
    venue: oneLine(facts.venueName),
    date: formatDate(locale, facts.startTs, tz),
    time: formatTime(locale, facts.startTs, tz),
  };
  const l = (k: string, v: Record<string, string | number> = {}) =>
    translateFor(locale, `emails.labels.${k}`, v);

  const [subject, intro] = await Promise.all([
    translateFor(locale, `emails.booking.${event}.subject`, values),
    translateFor(locale, `emails.booking.${event}.intro`, values),
  ]);

  const lines: string[] = [
    intro,
    '',
    `${await l('venue')}: ${values.venue}`,
    `${await l('court')}: ${oneLine(facts.courtName)}`,
    `${await l('when')}: ${formatWhen(locale, facts.startTs, facts.endTs, tz)}`,
    `${await l('zone')}: ${tz}`,
  ];

  if (event !== 'cancelledByClub') {
    const deadline = new Date(facts.startTs.getTime() - facts.cutoffHours * 3_600_000);
    lines.push(`${await l('payment')}: ${await l('paymentAtClub')}`);
    lines.push(
      `${await l('cancelUntil')}: ${
        deadline.getTime() > now.getTime()
          ? `${formatDate(locale, deadline, tz)}, ${formatTime(locale, deadline, tz)}`
          : await l('cancelPassed')
      }`,
    );
    lines.push('', `${await l('link')}: ${absoluteUrl(bookingHref(facts.bookingId))}`);
  }

  lines.push('', '—', await l('footer'), await l('settings', { url: absoluteUrl('/me/profile') }));

  return { subject: oneLine(subject), text: lines.join('\n') };
}

/** The series-cancelled email: one for the whole cancel, not one per week. */
export async function seriesCancelledEmail(
  rawLocale: unknown,
  facts: BookingFacts,
  fromDate: Date,
  count: number,
): Promise<{ subject: string; text: string }> {
  const locale = resolveLocale(rawLocale);
  const tz = facts.timezone;
  const values = {
    venue: oneLine(facts.venueName),
    date: formatDate(locale, fromDate, tz),
    count,
  };
  const l = (k: string, v: Record<string, string | number> = {}) =>
    translateFor(locale, `emails.labels.${k}`, v);
  const [subject, intro] = await Promise.all([
    translateFor(locale, 'emails.booking.seriesCancelled.subject', values),
    translateFor(locale, 'emails.booking.seriesCancelled.intro', values),
  ]);
  const lines = [
    intro,
    '',
    `${await l('venue')}: ${values.venue}`,
    `${await l('court')}: ${oneLine(facts.courtName)}`,
    `${await l('when')}: ${formatTime(locale, facts.startTs, tz)}–${formatTime(locale, facts.endTs, tz)}`,
    `${await l('zone')}: ${tz}`,
    '',
    '—',
    await l('footer'),
    await l('settings', { url: absoluteUrl('/me/profile') }),
  ];
  return { subject: oneLine(subject), text: lines.join('\n') };
}
