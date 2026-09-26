import nodemailer, { type Transporter } from 'nodemailer';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * Sending email.
 *
 * ═══ THE CONSOLE SINK THE ENV COMMENT ALREADY PROMISED ═══
 *
 * `src/env.ts` has declared `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
 * and `SMTP_FROM` for a long time, above a comment reading "when SMTP_HOST is
 * absent, console sink is used". Nothing read any of them. There was no
 * transport and no sink — the fallback that comment describes did not exist,
 * and neither did the thing it was a fallback for.
 *
 * That is why staff invites could not work (#199): a token with no way to
 * reach the person it is for.
 *
 * ═══ WHY ABSENT SMTP LOGS RATHER THAN THROWS ═══
 *
 * A developer running the stack locally has no SMTP server and should not need
 * one to exercise an invite. The sink writes the message — including the link —
 * to the log at info, so the flow is testable end to end from a clean checkout.
 *
 * This is the opposite of the cron-secret inversion the platform routes guard
 * against ("no credential configured, therefore no check"). Missing SMTP is not
 * a security control being skipped; it is a delivery mechanism being absent,
 * and the safe behaviour is to be loud about it rather than to refuse to run.
 *
 * It does refuse in production, though: an invite that silently went to a log
 * on the server is an invite the recipient never receives, and the club would
 * be left waiting for someone who was never told.
 */

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'SMTP is not configured and this is production. An invite written to the log is an ' +
        'invite nobody receives. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS.',
    );
    this.name = 'MailNotConfiguredError';
  }
}

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. No HTML: an invite is a sentence and a link. */
  text: string;
}

let cached: Transporter | null = null;

function transport(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (cached) return cached;

  cached = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    // 465 is implicit TLS; everything else upgrades with STARTTLS. Getting
    // this from the port rather than a separate flag removes a way to
    // configure a silently-plaintext connection.
    secure: (env.SMTP_PORT ?? 587) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  return cached;
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean }> {
  const t = transport();

  if (!t) {
    if (process.env.NODE_ENV === 'production') throw new MailNotConfiguredError();

    logger.info('email (console sink — SMTP not configured)', {
      component: 'email',
      to: mail.to,
      subject: mail.subject,
      // The body carries the invite link. Logged in full, deliberately: this
      // is a development sink and the link is the point of it.
      body: mail.text,
    });
    return { delivered: false };
  }

  await t.sendMail({ from: env.SMTP_FROM, to: mail.to, subject: mail.subject, text: mail.text });
  logger.info('email sent', { component: 'email', to: mail.to, subject: mail.subject });
  return { delivered: true };
}
