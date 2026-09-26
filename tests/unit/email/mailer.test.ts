/**
 * THE SMTP PATH HAD NO TEST, AND THAT IS HOW A DEPENDENCY BUMP BREAKS DELIVERY.
 *
 * `sendMail` falls back to a console sink whenever `SMTP_HOST` is absent, which
 * is every local run and every test run. So the branch that actually reaches
 * nodemailer — `createTransport`, then `transporter.sendMail` — was never
 * executed by anything. The invite integration test passes with the transport
 * completely broken, because it never builds one.
 *
 * That mattered immediately: nodemailer 7.0.13 carried two HIGH advisories
 * (GHSA-2x7j-588g-ccc2, GHSA-p6gq-j5cr-w38f) and the fix is a three-major jump
 * to 10.x. Nothing in the suite would have noticed if v10 had moved
 * `createTransport` off the default export.
 *
 * So these tests assert the CALL SHAPE against nodemailer rather than mocking
 * it away entirely: the mock stands in for the network, not for the module's
 * interface.
 */

const sendMailMock = jest.fn<Promise<unknown>, [unknown]>();
const createTransportMock = jest.fn((_options: Record<string, unknown>) => ({
  sendMail: sendMailMock,
}));
const infoMock = jest.fn();

interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
}

async function load(smtp: SmtpEnv, nodeEnv = 'test') {
  jest.resetModules();
  sendMailMock.mockReset().mockResolvedValue({ accepted: ['ok'] });
  createTransportMock.mockClear();
  infoMock.mockClear();

  jest.doMock('@/env', () => ({ env: { SMTP_FROM: 'noreply@playerz.bg', ...smtp } }));
  jest.doMock('@/lib/observability/logger', () => ({ logger: { info: infoMock } }));
  jest.doMock('nodemailer', () => ({
    __esModule: true,
    default: { createTransport: createTransportMock },
  }));

  // Set for the duration of the test, not just the import: `sendMail` reads
  // NODE_ENV when it is CALLED. Restored in afterEach below.
  Object.defineProperty(process.env, 'NODE_ENV', { value: nodeEnv, configurable: true });
  return import('@/lib/email/mailer');
}

const REAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: REAL_NODE_ENV,
    configurable: true,
  });
});

const MAIL = { to: 'coach@club.bg', subject: 'Покана', text: 'https://playerz.bg/invite/abc' };

describe('sendMail', () => {
  describe('with SMTP configured', () => {
    it('builds a transport and sends through it', async () => {
      const { sendMail } = await load({ SMTP_HOST: 'smtp.example.bg', SMTP_PORT: 587 });

      await expect(sendMail(MAIL)).resolves.toEqual({ delivered: true });

      // The whole point: this asserts nodemailer's interface, so a major bump
      // that moves `createTransport` fails here rather than in production.
      expect(createTransportMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock).toHaveBeenCalledWith({
        from: 'noreply@playerz.bg',
        to: MAIL.to,
        subject: MAIL.subject,
        text: MAIL.text,
      });
    });

    it.each([
      [465, true],
      [587, false],
      [25, false],
      [2525, false],
    ])('port %i derives secure=%s', async (port, secure) => {
      // Derived from the port rather than a separate flag, which removes a way
      // to configure a silently-plaintext connection. Worth pinning: getting
      // this backwards sends credentials in the clear and still "works".
      const { sendMail } = await load({ SMTP_HOST: 'smtp.example.bg', SMTP_PORT: port });
      await sendMail(MAIL);

      expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ port, secure }));
    });

    it('defaults to port 587 with STARTTLS when no port is given', async () => {
      const { sendMail } = await load({ SMTP_HOST: 'smtp.example.bg' });
      await sendMail(MAIL);

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({ port: 587, secure: false }),
      );
    });

    it('omits auth entirely when no user is set, rather than sending undefined credentials', async () => {
      const { sendMail } = await load({ SMTP_HOST: 'smtp.example.bg' });
      await sendMail(MAIL);

      expect(createTransportMock.mock.calls[0]![0]).toMatchObject({ auth: undefined });
    });

    it('reuses one transport across sends', async () => {
      // A new SMTP connection pool per invite would be a slow leak nobody
      // attributes to email.
      const { sendMail } = await load({ SMTP_HOST: 'smtp.example.bg' });
      await sendMail(MAIL);
      await sendMail(MAIL);

      expect(createTransportMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('without SMTP configured', () => {
    it('writes the body to the log and reports it was NOT delivered', async () => {
      const { sendMail } = await load({});

      // `delivered: false` is the contract that matters. A sink reporting
      // success would tell a caller the invite is on its way when it is not.
      await expect(sendMail(MAIL)).resolves.toEqual({ delivered: false });
      expect(createTransportMock).not.toHaveBeenCalled();
      expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining('console sink'),
        expect.objectContaining({ to: MAIL.to, body: MAIL.text }),
      );
    });

    it('refuses in production instead of logging the invite', async () => {
      const { sendMail, MailNotConfiguredError } = await load({}, 'production');

      await expect(sendMail(MAIL)).rejects.toBeInstanceOf(MailNotConfiguredError);
      expect(infoMock).not.toHaveBeenCalled();
    });
  });
});
