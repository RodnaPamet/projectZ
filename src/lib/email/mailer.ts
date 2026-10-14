import { logger } from '@/lib/observability/logger';

import { emailProvider } from './provider';

/**
 * One email sent now, to an address that may not belong to any account yet:
 * a staff invite (#199), or the code that confirms an address after a hidden
 * Apple sign-in (#442). Everything else goes through the notification outbox,
 * which resolves its recipient from a user id at send time.
 *
 * ═══ THE SAME ADAPTER AS EVERY OTHER EMAIL (#425) ═══
 *
 * This used to build its own SMTP transport, so an invite needed SMTP_HOST
 * while every other email went through Resend. Production has a Resend key
 * and no SMTP server, so every staff invite failed there with MAIL_FAILED.
 * It now sends through `emailProvider()` (src/lib/email/provider.ts):
 * Resend when its key is set, else SMTP, else log-only. It also obeys that
 * file's staging rule, so staging emails nobody unless EMAIL_ALLOW_ON_STAGING=1.
 *
 * ═══ LOG-ONLY IS NEVER REPORTED AS SENT ═══
 *
 * Production with no provider throws `MailNotConfiguredError`. An invite
 * written to a server log is one nobody receives, and the admin must be told
 * so they can withdraw it. Anywhere else (development, staging), the log-only
 * adapter answers `delivered: false`. Outside production the body, link
 * included, goes to the log so the flow can be followed end to end from a
 * clean checkout; staging runs as production, so its log never holds a link.
 */

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'No email provider is configured and this is production. An invite written to the log ' +
        'is an invite nobody receives. Set RESEND_API_KEY (or SMTP_HOST).',
    );
    this.name = 'MailNotConfiguredError';
  }
}

export class MailNotSentError extends Error {
  constructor(readonly reason: string) {
    super(`The email provider refused the message: ${reason}`);
    this.name = 'MailNotSentError';
  }
}

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. No HTML: an invite is a sentence and a link. */
  text: string;
  /** Stable for one message, so a provider that dedupes can. */
  idempotencyKey?: string;
  /** What kind of message, for the provider's tags and the log. */
  ref?: 'staff-invite' | 'apple-email-code';
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean }> {
  const provider = emailProvider();

  if (provider.name === 'log') {
    const production = process.env.NODE_ENV === 'production';
    if (production && provider.reason === 'no-provider') throw new MailNotConfiguredError();
    logger.info('email not sent: log-only provider', {
      component: 'email',
      reason: provider.reason,
      subject: mail.subject,
      // The body carries the invite link: a development convenience, never in
      // a production (or staging) log.
      ...(production ? {} : { to: mail.to, body: mail.text }),
    });
    return { delivered: false };
  }

  const outcome = await provider.send({
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    idempotencyKey: mail.idempotencyKey,
    ref: mail.ref ?? 'staff-invite',
  });
  if (!outcome.ok) throw new MailNotSentError(outcome.error);
  logger.info('email sent', {
    component: 'email',
    provider: provider.name,
    ref: mail.ref ?? 'staff-invite',
  });
  return { delivered: true };
}
