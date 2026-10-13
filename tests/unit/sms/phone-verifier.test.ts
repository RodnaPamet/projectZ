/**
 * @jest-environment node
 */
import { testVerifier, twilioVerifier, verifierFor } from '@/lib/sms/phone-verifier';

/**
 * Who sends and checks the SMS code (#500): which verifier a configuration
 * gives, and how Twilio Verify's answers are read.
 */
const SID = `AC${'a'.repeat(32)}`;
const SERVICE = `VA${'b'.repeat(32)}`;
const KEYS = {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: 't'.repeat(32), // pragma: allowlist secret
  TWILIO_VERIFY_SERVICE_SID: SERVICE,
};

describe('verifierFor', () => {
  it('Twilio when all three settings are there', () => {
    expect(verifierFor({ ...KEYS, DEPLOY_ENV: 'production' })?.name).toBe('twilio');
    expect(verifierFor({ ...KEYS, DEPLOY_ENV: 'staging' })?.name).toBe('twilio');
  });

  it('none with a setting missing: a half-configured account sends nothing', () => {
    for (const missing of Object.keys(KEYS) as Array<keyof typeof KEYS>) {
      expect(verifierFor({ ...KEYS, [missing]: undefined, DEPLOY_ENV: 'production' })).toBeNull();
    }
    expect(verifierFor({ DEPLOY_ENV: 'production' })).toBeNull();
  });

  it('the test code works under DEPLOY_ENV=test only, never in production or staging', () => {
    expect(verifierFor({ DEPLOY_ENV: 'test', PHONE_VERIFY_TEST_CODE: '000000' })?.name).toBe(
      'test',
    );
    expect(verifierFor({ DEPLOY_ENV: 'production', PHONE_VERIFY_TEST_CODE: '000000' })).toBeNull();
    expect(verifierFor({ DEPLOY_ENV: 'staging', PHONE_VERIFY_TEST_CODE: '000000' })).toBeNull();
    expect(verifierFor({ PHONE_VERIFY_TEST_CODE: '000000' })).toBeNull();
    // Real keys win over the test code.
    expect(
      verifierFor({ ...KEYS, DEPLOY_ENV: 'test', PHONE_VERIFY_TEST_CODE: '000000' })?.name,
    ).toBe('twilio');
  });
});

describe('testVerifier', () => {
  it('sends nothing and accepts its one code', async () => {
    const v = testVerifier('424242');
    expect(await v.start('+359888123456', 'bg')).toEqual({ ok: true });
    expect(await v.check('+359888123456', '424242')).toEqual({ ok: true });
    expect(await v.check('+359888123456', '000000')).toEqual({ ok: false, reason: 'wrong' });
  });
});

describe('twilioVerifier', () => {
  type Call = { url: string; init: RequestInit };
  const answer = (status: number, body: unknown) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, verifier: twilioVerifier(KEYS, fetchImpl) };
  };

  it('start posts the number to the service, as a form, with the account’s credentials', async () => {
    const { calls, verifier } = answer(201, { status: 'pending' });
    expect(await verifier.start('+359888123456', 'en')).toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://verify.twilio.com/v2/Services/${SERVICE}/Verifications`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:${KEYS.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(Object.fromEntries(form)).toEqual({ To: '+359888123456', Channel: 'sms', Locale: 'en' });
  });

  it('start asks for Bulgarian unless the person reads English', async () => {
    const { calls, verifier } = answer(201, {});
    await verifier.start('+359888123456', 'bg');
    await verifier.start('+359888123456', 'xx');
    expect(calls.map((c) => new URLSearchParams(c.init.body as string).get('Locale'))).toEqual([
      'bg',
      'bg',
    ]);
  });

  it.each([
    [400, 60200, 'invalid'],
    [400, 60205, 'invalid'],
    [400, 21211, 'invalid'],
    [429, 60203, 'limited'],
    [429, undefined, 'limited'],
    [500, undefined, 'failed'],
    [401, 20003, 'failed'],
  ])('start: HTTP %s with Twilio code %s is "%s"', async (status, code, reason) => {
    const { verifier } = answer(status, code === undefined ? {} : { code });
    expect(await verifier.start('+359888123456', 'bg')).toEqual({ ok: false, reason });
  });

  it('check: approved is the only yes', async () => {
    expect(
      await answer(200, { status: 'approved' }).verifier.check('+359888123456', '123456'),
    ).toEqual({ ok: true });
    for (const status of ['pending', 'canceled', undefined]) {
      expect(await answer(200, { status }).verifier.check('+359888123456', '123456')).toEqual({
        ok: false,
        reason: 'wrong',
      });
    }
  });

  it('check posts the number and the code to VerificationCheck', async () => {
    const { calls, verifier } = answer(200, { status: 'approved' });
    await verifier.check('+359888123456', '123456');
    expect(calls[0]!.url).toBe(
      `https://verify.twilio.com/v2/Services/${SERVICE}/VerificationCheck`,
    );
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.init.body as string))).toEqual({
      To: '+359888123456',
      Code: '123456',
    });
  });

  it.each([
    [404, 20404, 'expired'],
    [429, 60202, 'limited'],
    [400, 60202, 'limited'],
    [500, undefined, 'failed'],
  ])('check: HTTP %s with Twilio code %s is "%s"', async (status, code, reason) => {
    const { verifier } = answer(status, code === undefined ? {} : { code });
    expect(await verifier.check('+359888123456', '123456')).toEqual({ ok: false, reason });
  });

  it('a network failure is "failed", never a yes', async () => {
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const verifier = twilioVerifier(KEYS, down);
    expect(await verifier.start('+359888123456', 'bg')).toEqual({ ok: false, reason: 'failed' });
    expect(await verifier.check('+359888123456', '123456')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('an answer that is not JSON is read by its status alone', async () => {
    const html = (async () =>
      new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    expect(await twilioVerifier(KEYS, html).check('+359888123456', '123456')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});
