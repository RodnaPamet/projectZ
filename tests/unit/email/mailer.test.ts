/**
 * Staff invites send through the same adapter as every other email (#425).
 *
 * They used to need SMTP, which production does not have, so every invite
 * failed there. The SMTP and Resend call shapes are pinned in provider.test.ts;
 * this pins what the invite path does with each adapter, and above all that a
 * log-only adapter is never reported as delivered.
 */
import type { EmailProvider, OutgoingEmail, SendOutcome } from '@/lib/email/provider';

const infoMock = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
  logger: { info: (...a: unknown[]) => infoMock(...a) },
}));

let provider: EmailProvider;
jest.mock('@/lib/email/provider', () => ({ emailProvider: () => provider }));

import { MailNotConfiguredError, MailNotSentError, sendMail } from '@/lib/email/mailer';

const MAIL = { to: 'coach@club.bg', subject: 'Покана', text: 'https://playerz.bg/invite/abc' };
const REAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  Object.defineProperty(process.env, 'NODE_ENV', { value, configurable: true });
}

function sending(outcome: SendOutcome, name: 'resend' | 'smtp' = 'resend') {
  const send = jest.fn(async (_m: OutgoingEmail) => outcome);
  provider = { name, send };
  return send;
}

function logOnly(reason: 'no-provider' | 'staging') {
  const send = jest.fn();
  provider = { name: 'log', reason, send };
  return send;
}

beforeEach(() => infoMock.mockClear());
afterEach(() => setNodeEnv(REAL_NODE_ENV));

describe('sendMail (staff invites)', () => {
  it('sends through the configured provider and reports it delivered', async () => {
    const send = sending({ ok: true, messageId: 'm1' });
    await expect(sendMail({ ...MAIL, idempotencyKey: 'invite:1' })).resolves.toEqual({
      delivered: true,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: MAIL.to,
        subject: MAIL.subject,
        text: MAIL.text,
        idempotencyKey: 'invite:1',
      }),
    );
  });

  it('throws when the provider refuses, so the admin is told', async () => {
    sending({ ok: false, permanent: true, error: 'validation_error' });
    await expect(sendMail(MAIL)).rejects.toBeInstanceOf(MailNotSentError);
  });

  it('refuses in production with no provider instead of logging the invite', async () => {
    setNodeEnv('production');
    const send = logOnly('no-provider');
    await expect(sendMail(MAIL)).rejects.toBeInstanceOf(MailNotConfiguredError);
    expect(send).not.toHaveBeenCalled();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('on staging: not delivered, and the link stays out of the log', async () => {
    setNodeEnv('production');
    logOnly('staging');
    await expect(sendMail(MAIL)).resolves.toEqual({ delivered: false });
    const fields = infoMock.mock.calls[0][1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty('body');
    expect(fields).not.toHaveProperty('to');
  });

  it('in development: not delivered, and the body goes to the log to follow the flow', async () => {
    setNodeEnv('development');
    logOnly('no-provider');
    await expect(sendMail(MAIL)).resolves.toEqual({ delivered: false });
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining('log-only'),
      expect.objectContaining({ to: MAIL.to, body: MAIL.text }),
    );
  });
});
