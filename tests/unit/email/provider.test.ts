/**
 * Which adapter sends notification email (#367), and the staging guard.
 *
 * `selectEmailProvider` is pure over its config, so every branch is driven
 * here without touching the environment. The Resend and SMTP adapters are
 * exercised against mocks standing in for the network, not for their
 * interfaces: the call shape is what a dependency bump would break.
 */

const resendSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: resendSend } })),
}));
const smtpSend = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: smtpSend })) },
}));
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
  logger: { info: (...a: unknown[]) => info(...a), warn: jest.fn(), error: jest.fn() },
}));

import {
  fromAddress,
  headerSafe,
  isDeliverableAddress,
  selectEmailProvider,
} from '@/lib/email/provider';

const MAIL = { to: 'ivo@example.bg', subject: 'Резервацията е потвърдена', text: 'Здравейте' };

beforeEach(() => {
  resendSend.mockReset();
  smtpSend.mockReset();
  info.mockReset();
});

describe('choosing the adapter', () => {
  it('Resend when its key is set, before SMTP', () => {
    expect(selectEmailProvider({ RESEND_API_KEY: 're_x', SMTP_HOST: 'smtp.x' }).name).toBe(
      'resend',
    );
  });
  it('SMTP when only SMTP is set', () => {
    expect(selectEmailProvider({ SMTP_HOST: 'smtp.x' }).name).toBe('smtp');
  });
  it('log-only with neither: production keeps working and sends nothing', async () => {
    const p = selectEmailProvider({});
    expect(p).toMatchObject({ name: 'log', reason: 'no-provider' });
    await expect(p.send(MAIL)).resolves.toEqual({ ok: true, messageId: null });
    expect(resendSend).not.toHaveBeenCalled();
    expect(smtpSend).not.toHaveBeenCalled();
  });
});

describe('staging never emails anyone', () => {
  it('forces log-only whatever keys are set', async () => {
    const p = selectEmailProvider({
      DEPLOY_ENV: 'staging',
      RESEND_API_KEY: 're_x',
      SMTP_HOST: 'smtp.x',
    });
    expect(p).toMatchObject({ name: 'log', reason: 'staging' });
    await p.send(MAIL);
    expect(resendSend).not.toHaveBeenCalled();
    expect(smtpSend).not.toHaveBeenCalled();
  });
  it('unless EMAIL_ALLOW_ON_STAGING=1 says so on purpose', () => {
    expect(
      selectEmailProvider({
        DEPLOY_ENV: 'staging',
        EMAIL_ALLOW_ON_STAGING: '1',
        RESEND_API_KEY: 're_x',
      }).name,
    ).toBe('resend');
    expect(
      selectEmailProvider({
        DEPLOY_ENV: 'staging',
        EMAIL_ALLOW_ON_STAGING: '0',
        RESEND_API_KEY: 're_x',
      }).name,
    ).toBe('log');
  });
});

describe('the log-only adapter', () => {
  it('logs neither the address nor the body', async () => {
    await selectEmailProvider({}).send({ ...MAIL, ref: 'out_1' });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('out_1');
    expect(logged).not.toContain('ivo@example.bg');
    expect(logged).not.toContain('Здравейте');
  });
});

describe('Resend', () => {
  const p = () =>
    selectEmailProvider({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'playerz.bg <noreply@playerz.bg>' });

  it('sends plain text from EMAIL_FROM, with the idempotency key', async () => {
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    await expect(p().send({ ...MAIL, idempotencyKey: 'outbox-1' })).resolves.toEqual({
      ok: true,
      messageId: 'msg_1',
    });
    expect(resendSend).toHaveBeenCalledWith(
      {
        from: 'playerz.bg <noreply@playerz.bg>',
        to: ['ivo@example.bg'],
        subject: MAIL.subject,
        text: MAIL.text,
      },
      { idempotencyKey: 'outbox-1' },
    );
  });

  it('a refused message is permanent; a rate limit or our own bad key is retried', async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error' } });
    await expect(p().send(MAIL)).resolves.toMatchObject({ ok: false, permanent: true });
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded' } });
    await expect(p().send(MAIL)).resolves.toMatchObject({ ok: false, permanent: false });
    resendSend.mockResolvedValueOnce({ data: null, error: { name: 'invalid_from_address' } });
    await expect(p().send(MAIL)).resolves.toMatchObject({ ok: false, permanent: false });
    resendSend.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(p().send(MAIL)).resolves.toMatchObject({ ok: false, permanent: false });
  });
});

describe('SMTP', () => {
  it('a 5xx refusal is permanent, anything else is retried', async () => {
    const p = selectEmailProvider({ SMTP_HOST: 'smtp.x' });
    smtpSend.mockResolvedValueOnce({ messageId: '<m@x>' });
    await expect(p.send(MAIL)).resolves.toEqual({ ok: true, messageId: '<m@x>' });
    smtpSend.mockRejectedValueOnce(Object.assign(new Error('no such user'), { responseCode: 550 }));
    await expect(p.send(MAIL)).resolves.toMatchObject({ ok: false, permanent: true });
    smtpSend.mockRejectedValueOnce(Object.assign(new Error('try later'), { responseCode: 421 }));
    await expect(p.send(MAIL)).resolves.toMatchObject({ ok: false, permanent: false });
  });
});

describe('header injection', () => {
  it('a subject or From can never carry a second header line', () => {
    expect(headerSafe('Sofia Padel\r\nBcc: victim@x.bg')).toBe('Sofia Padel Bcc: victim@x.bg');
    expect(headerSafe('a b\u0000c')).toBe('a b c');
    expect(fromAddress({ EMAIL_FROM: 'x <a@b.bg>\nBcc: c@d.bg' })).not.toMatch(/[\r\n]/);
  });

  it('an address must be one plain address', () => {
    expect(isDeliverableAddress('ivo@example.bg')).toBe(true);
    expect(isDeliverableAddress('ivo@example.bg\r\nBcc: x@y.bg')).toBe(false);
    expect(isDeliverableAddress('a@b.bg, c@d.bg')).toBe(false);
    expect(isDeliverableAddress('Ivo <ivo@example.bg>')).toBe(false);
    expect(isDeliverableAddress('not-an-address')).toBe(false);
  });
});
