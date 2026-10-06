import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * Where an email actually goes (#367): one adapter, chosen once per process.
 *
 *   RESEND_API_KEY set            → Resend's HTTP API
 *   else SMTP_HOST set            → SMTP through nodemailer
 *   else                          → log-only: the row is marked SENT by the
 *                                   `log` provider and nothing leaves the box
 *
 * ═══ STAGING NEVER EMAILS ANYONE ═══
 *
 * `DEPLOY_ENV=staging` forces the log-only adapter whatever keys are set,
 * unless `EMAIL_ALLOW_ON_STAGING=1` says otherwise on purpose. Staging runs on
 * a copy of real data, and a reminder sent from it reaches a real person about
 * a booking that may not exist.
 *
 * ═══ PRODUCTION WITH NO PROVIDER KEEPS WORKING ═══
 *
 * Unlike the staff-invite path, the notification outbox does not refuse to run
 * without a provider: the bell has the notification either way, and the owner
 * adds a key when the sending domain is ready. Until then the drain logs that
 * it is log-only (once per run) and sends nothing.
 *
 * ═══ WHAT IS LOGGED ═══
 *
 * Never the address and never the body: the outbox row id, the kind, and the
 * provider's message id. The log-only adapter logs the subject outside
 * production only, so a developer can see the flow work end to end.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  /** Plain text. There is no HTML part, so there is nothing to track with. */
  text: string;
  /** Stable across retries of one outbox row, so the provider can dedupe. */
  idempotencyKey?: string;
  /** For the log only. */
  ref?: string;
}

export type SendOutcome =
  | { ok: true; messageId: string | null }
  /** `permanent`: retrying cannot help (a refused address, a bad key). */
  | { ok: false; permanent: boolean; error: string };

export interface EmailProvider {
  readonly name: 'resend' | 'smtp' | 'log';
  /** Why the log-only adapter was chosen, when it was. */
  readonly reason?: 'no-provider' | 'staging';
  send(mail: OutgoingEmail): Promise<SendOutcome>;
}

export interface EmailConfig {
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  EMAIL_FROM?: string;
  SMTP_FROM?: string;
  DEPLOY_ENV?: string;
  EMAIL_ALLOW_ON_STAGING?: string;
}

function configFromEnv(): EmailConfig {
  return {
    RESEND_API_KEY: env.RESEND_API_KEY,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    EMAIL_FROM: env.EMAIL_FROM,
    SMTP_FROM: env.SMTP_FROM,
    DEPLOY_ENV: env.DEPLOY_ENV,
    EMAIL_ALLOW_ON_STAGING: env.EMAIL_ALLOW_ON_STAGING,
  };
}

/** A header value may not carry a line break or a control character. */
export function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

/** A single plain address, nothing a header could be smuggled in with. */
export function isDeliverableAddress(value: string): boolean {
  return /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(value);
}

/** `playerz.bg <noreply@playerz.bg>` from EMAIL_FROM, else SMTP_FROM. */
export function fromAddress(config: EmailConfig): string {
  return headerSafe(config.EMAIL_FROM || config.SMTP_FROM || 'playerz.bg <noreply@playerz.bg>');
}

/**
 * Resend errors a retry cannot fix: the message itself is refused. Everything
 * else is retried, INCLUDING a bad key or an unverified sending domain
 * (`invalid_api_Key`, `invalid_from_address`): those are OUR configuration,
 * the owner fixes them, and the emails waiting should then go rather than all
 * have been dead-lettered in the meantime. The drain logs them at error.
 */
const RESEND_PERMANENT = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_parameter',
  'invalid_idempotency_key',
]);

function resendPermanent(name: string | undefined): boolean {
  return !!name && RESEND_PERMANENT.has(name);
}

class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly client: Resend;
  constructor(
    key: string,
    private readonly from: string,
  ) {
    this.client = new Resend(key);
  }

  async send(mail: OutgoingEmail): Promise<SendOutcome> {
    try {
      const { data, error } = await this.client.emails.send(
        { from: this.from, to: [mail.to], subject: headerSafe(mail.subject), text: mail.text },
        mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : undefined,
      );
      if (error) return { ok: false, permanent: resendPermanent(error.name), error: error.name };
      return { ok: true, messageId: data?.id ?? null };
    } catch (err) {
      // A network failure: worth another go.
      return { ok: false, permanent: false, error: err instanceof Error ? err.name : 'error' };
    }
  }
}

class SmtpProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  private readonly transport: Transporter;
  constructor(
    config: EmailConfig,
    private readonly from: string,
  ) {
    const port = config.SMTP_PORT ?? 587;
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port,
      secure: port === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }

  async send(mail: OutgoingEmail): Promise<SendOutcome> {
    try {
      const info = (await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        subject: headerSafe(mail.subject),
        text: mail.text,
        ...(mail.idempotencyKey ? { messageId: `<${mail.idempotencyKey}@playerz.bg>` } : {}),
      })) as { messageId?: string };
      return { ok: true, messageId: info.messageId ?? null };
    } catch (err) {
      // 5xx from the server is a refusal (no such mailbox, policy); anything
      // else — a timeout, a 4xx "try later" — is transient.
      const code = (err as { responseCode?: number }).responseCode;
      return {
        ok: false,
        permanent: typeof code === 'number' && code >= 500,
        error:
          typeof code === 'number' ? `smtp ${code}` : err instanceof Error ? err.name : 'error',
      };
    }
  }
}

class LogProvider implements EmailProvider {
  readonly name = 'log' as const;
  constructor(readonly reason: 'no-provider' | 'staging') {}

  async send(mail: OutgoingEmail): Promise<SendOutcome> {
    logger.info('email not sent (log-only adapter)', {
      component: 'email',
      reason: this.reason,
      ref: mail.ref,
      // The subject names a venue and a time, never a person; and only off
      // production, where it helps to see the flow work.
      ...(process.env.NODE_ENV !== 'production' ? { subject: mail.subject } : {}),
    });
    return { ok: true, messageId: null };
  }
}

/** Pick the adapter. Pure over `config`, so tests can drive every branch. */
export function selectEmailProvider(config: EmailConfig = configFromEnv()): EmailProvider {
  if (config.DEPLOY_ENV === 'staging' && config.EMAIL_ALLOW_ON_STAGING !== '1') {
    return new LogProvider('staging');
  }
  const from = fromAddress(config);
  if (config.RESEND_API_KEY) return new ResendProvider(config.RESEND_API_KEY, from);
  if (config.SMTP_HOST) return new SmtpProvider(config, from);
  return new LogProvider('no-provider');
}

let cached: EmailProvider | null = null;

/** The process's adapter. Tests replace it with `setEmailProviderForTests`. */
export function emailProvider(): EmailProvider {
  cached ??= selectEmailProvider();
  return cached;
}

export function setEmailProviderForTests(provider: EmailProvider | null): void {
  cached = provider;
}
