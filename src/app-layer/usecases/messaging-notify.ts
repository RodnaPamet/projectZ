import { translateFor } from '@/lib/i18n/server-messages';
import { absoluteUrl } from '@/lib/seo/site-url';
import { dedupeKey } from '@/lib/notifications/dedupe';
import { conversationPath } from '@/lib/messaging/paths';
import { logger } from '@/lib/observability/logger';

import { messageAudience, type MessageAudience } from './messaging-directory';
import { deliver } from './notification-outbox';

/**
 * Telling people a message arrived (#375). Runs AFTER the sender's transaction
 * has committed — `sendMessage` awaits its binding first — and never throws:
 * the message is already said, and a notification failing must not turn that
 * into an error the sender sees.
 *
 * ═══ THE SEAM FOR A TRANSPORT ═══
 *
 * There is no broker; an open conversation refreshes every 5 seconds. When a
 * push transport arrives (Centrifugo), it is published from HERE, after the
 * commit, with the same recipients: publish-then-persist shows a message that
 * may never exist, persist-then-publish at worst shows one a moment late.
 *
 * ═══ ONE BELL ROW PER UNREAD STRETCH ═══
 *
 * Not one per message — ten lines in a minute are one conversation, not ten
 * bell entries — and not one per day either: Agrent deduped its bell by the
 * day and a live conversation then notified on NO channel from its second
 * message on (agri-saas #1102). The key carries the recipient's read pointer,
 * so the first message after they last read the conversation rings, and the
 * next one after they read it again rings again. Reading the conversation
 * marks its bell rows read (`markReadFor`).
 *
 * ═══ THE EMAIL WAITS, AND ASKS AGAIN ═══
 *
 * With the bell, an email is queued (the owner's rule, #375): not sent before
 * `EMAIL_DELAY_MS` (about ten minutes), and only if the message is still
 * unread then — the drain asks (`unreadAtSendTime`) and skips it as 'read'
 * otherwise; at most one per conversation per hour (`atMostOncePer`); and
 * only to people who leave «Съобщения» on in Профил, which the drain also
 * re-reads at send time. It says who wrote and links the conversation; it
 * never carries the text, which is ciphertext at rest and stays on playerz.
 */

/** How long a message's email waits for the message to be read first. */
export const EMAIL_DELAY_MS = 10 * 60_000;
/** At most one message email per conversation per person in this long. */
export const EMAIL_WINDOW_MS = 60 * 60_000;

/** The copy is the recipient's language; a name is one line of text. */
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

async function emailCopy(
  locale: string,
  audience: MessageAudience,
  side: 'player' | 'club',
  href: string,
): Promise<{ subject: string; text: string }> {
  const someone = await translateFor(locale, 'notifications.message.someone');
  const name = audience.senderName?.trim() ? oneLine(audience.senderName) : someone;
  const club = audience.club ? oneLine(audience.club.name) : '';
  const event =
    audience.type === 'DM'
      ? audience.request
        ? 'request'
        : 'fromPlayer'
      : side === 'club'
        ? 'toClub'
        : 'fromClub';
  const values = { name, club };
  const [subject, intro, link, footer, settings] = await Promise.all([
    translateFor(locale, `emails.message.${event}.subject`, values),
    translateFor(locale, `emails.message.${event}.intro`, values),
    translateFor(locale, 'emails.message.link', { url: absoluteUrl(href) }),
    translateFor(locale, 'emails.message.footer'),
    translateFor(locale, 'emails.labels.settings', { url: absoluteUrl('/me/profile') }),
  ]);
  return {
    subject: oneLine(subject),
    text: [intro, '', link, '', '—', footer, settings].join('\n'),
  };
}

async function bellCopy(
  locale: string,
  audience: MessageAudience,
  side: 'player' | 'club',
): Promise<{ title: string; body: string }> {
  const someone = await translateFor(locale, 'notifications.message.someone');
  const name = audience.senderName?.trim() ? oneLine(audience.senderName) : someone;
  const club = audience.club ? oneLine(audience.club.name) : '';
  const event =
    audience.type === 'DM'
      ? audience.request
        ? 'request'
        : 'fromPlayer'
      : side === 'club'
        ? 'toClub'
        : 'fromClub';
  const values = { name, club };
  const [title, body] = await Promise.all([
    translateFor(locale, `notifications.message.${event}.title`, values),
    translateFor(locale, `notifications.message.${event}.body`, values),
  ]);
  return { title, body };
}

/** Where the bell sends each side: a player's inbox, or the club's. */
export function conversationHref(
  side: 'player' | 'club',
  conversationId: string,
  clubSlug: string | null,
): string {
  return conversationPath(
    side === 'club' && clubSlug ? { kind: 'club', slug: clubSlug } : { kind: 'me' },
    conversationId,
  );
}

export async function notifyNewMessage(input: {
  conversationId: string;
  messageId: string;
  sender: { userId: string };
}): Promise<void> {
  try {
    const audience = await messageAudience(input.conversationId, input.sender.userId);
    if (!audience) return;

    // One recipient at a time: each is their own transaction (`deliver` binds
    // to that person), and one failing must not cost the others theirs.
    const now = Date.now();
    for (const r of audience.recipients) {
      const href = conversationHref(r.side, input.conversationId, audience.club?.slug ?? null);
      const [{ title, body }, email] = await Promise.all([
        bellCopy(r.locale, audience, r.side),
        emailCopy(r.locale, audience, r.side, href),
      ]);
      await deliver({
        userId: r.userId,
        tenantId: audience.club?.tenantId ?? null,
        kind: 'MESSAGE_RECEIVED',
        dedupeKey: dedupeKey(
          'message',
          input.conversationId,
          r.lastReadAt ? r.lastReadAt.getTime() : 'unread',
        ),
        title,
        body,
        href,
        refType: 'conversation',
        refId: input.conversationId,
        email: {
          category: 'messages',
          subject: email.subject,
          text: email.text,
          locale: r.locale === 'en' ? 'en' : 'bg',
          notBefore: new Date(now + EMAIL_DELAY_MS),
          atMostOncePer: EMAIL_WINDOW_MS,
        },
      });
    }
  } catch (err) {
    logger.warn('message notification failed', {
      component: 'messaging',
      conversationId: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
