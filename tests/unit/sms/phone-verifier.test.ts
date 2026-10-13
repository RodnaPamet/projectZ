/**
 * @jest-environment node
 */
import { infobipVerifier, testVerifier, verifierFor } from '@/lib/sms/phone-verifier';

/**
 * Who sends and checks the SMS code (#500): which verifier a configuration
 * gives, and how Infobip's 2FA API is asked and its answers read.
 */
const KEYS = {
  INFOBIP_BASE_URL: 'https://abc123.api.infobip.com',
  INFOBIP_API_KEY: 'k'.repeat(40), // pragma: allowlist secret
  INFOBIP_2FA_APPLICATION_ID: 'A'.repeat(32),
  INFOBIP_2FA_MESSAGE_ID: 'B'.repeat(32),
};
const EN = 'E'.repeat(32);

describe('verifierFor', () => {
  it('Infobip when its four settings are there', () => {
    expect(verifierFor({ ...KEYS, DEPLOY_ENV: 'production' })?.name).toBe('infobip');
    expect(verifierFor({ ...KEYS, DEPLOY_ENV: 'staging' })?.name).toBe('infobip');
  });

  it('none with a setting missing: a half-configured account sends nothing', () => {
    for (const missing of Object.keys(KEYS) as Array<keyof typeof KEYS>) {
      expect(verifierFor({ ...KEYS, [missing]: undefined, DEPLOY_ENV: 'production' })).toBeNull();
    }
    expect(verifierFor({ DEPLOY_ENV: 'production' })).toBeNull();
    // The English template alone is not a configuration.
    expect(verifierFor({ INFOBIP_2FA_MESSAGE_ID_EN: EN, DEPLOY_ENV: 'production' })).toBeNull();
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
    ).toBe('infobip');
  });
});

describe('testVerifier', () => {
  it('sends nothing and accepts its one code', async () => {
    const v = testVerifier('424242');
    const started = await v.start('+359888123456', 'bg');
    expect(started).toEqual({ ok: true, ref: expect.any(String) });
    const ref = (started as { ref: string }).ref;
    expect(await v.check(ref, '424242')).toEqual({ ok: true });
    expect(await v.check(ref, '000000')).toEqual({ ok: false, reason: 'wrong' });
  });
});

describe('infobipVerifier', () => {
  type Call = { url: string; init: RequestInit };
  const answer = (status: number, body: unknown, cfg: object = {}) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, verifier: infobipVerifier({ ...KEYS, ...cfg }, fetchImpl) };
  };
  const SENT = { pinId: 'PIN123', to: '359888123456', smsStatus: 'MESSAGE_SENT' };

  it('start posts the application, the template and the number, with the account’s key', async () => {
    const { calls, verifier } = answer(200, SENT);
    expect(await verifier.start('+359888123456', 'bg')).toEqual({ ok: true, ref: 'PIN123' });

    expect(calls).toHaveLength(1);
    // No number lookup before sending: it is a separate product.
    expect(calls[0]!.url).toBe('https://abc123.api.infobip.com/2fa/2/pin?ncNeeded=false');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`App ${KEYS.INFOBIP_API_KEY}`);
    expect(headers['content-type']).toBe('application/json');
    // Infobip writes a number as digits, with no plus.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      applicationId: KEYS.INFOBIP_2FA_APPLICATION_ID,
      messageId: KEYS.INFOBIP_2FA_MESSAGE_ID,
      to: '359888123456',
    });
  });

  it('a trailing slash on the host does not double up', async () => {
    const { calls, verifier } = answer(200, SENT, {
      INFOBIP_BASE_URL: 'https://abc123.api.infobip.com/',
    });
    await verifier.start('+359888123456', 'bg');
    expect(calls[0]!.url).toBe('https://abc123.api.infobip.com/2fa/2/pin?ncNeeded=false');
  });

  it('the English text goes to a person who reads English, when there is one', async () => {
    const template = async (cfg: object, locale: string) => {
      const { calls, verifier } = answer(200, SENT, cfg);
      await verifier.start('+359888123456', locale);
      return (JSON.parse(calls[0]!.init.body as string) as { messageId: string }).messageId;
    };
    expect(await template({ INFOBIP_2FA_MESSAGE_ID_EN: EN }, 'en')).toBe(EN);
    expect(await template({ INFOBIP_2FA_MESSAGE_ID_EN: EN }, 'bg')).toBe(
      KEYS.INFOBIP_2FA_MESSAGE_ID,
    );
    // No English template: Bulgarian for everybody.
    expect(await template({}, 'en')).toBe(KEYS.INFOBIP_2FA_MESSAGE_ID);
  });

  it.each([
    [200, { pinId: 'P', smsStatus: 'MESSAGE_NOT_SENT' }, 'failed'],
    [
      200,
      { pinId: 'P', smsStatus: 'MESSAGE_NOT_SENT', ncStatus: 'NC_DESTINATION_NOT_REACHABLE' },
      'invalid',
    ],
    [200, { smsStatus: 'MESSAGE_SENT' }, 'failed'], // sent, it says, with no id to check by
    [400, { requestError: { serviceException: { text: 'Bad request' } } }, 'invalid'],
    [429, {}, 'limited'],
    [401, {}, 'failed'],
    [500, {}, 'failed'],
  ])('start: HTTP %s %j is "%s"', async (status, body, reason) => {
    const { verifier } = answer(status, body);
    expect(await verifier.start('+359888123456', 'bg')).toEqual({ ok: false, reason });
  });

  it('check posts the digits to the pin it was given', async () => {
    const { calls, verifier } = answer(200, { pinId: 'PIN123', verified: true });
    expect(await verifier.check('PIN123', '123456')).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://abc123.api.infobip.com/2fa/2/pin/PIN123/verify');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ pin: '123456' });
  });

  it('a ref cannot reach another path', async () => {
    const { calls, verifier } = answer(404, {});
    await verifier.check('../../sms/3/messages', '123456');
    expect(calls[0]!.url).toBe(
      'https://abc123.api.infobip.com/2fa/2/pin/..%2F..%2Fsms%2F3%2Fmessages/verify',
    );
  });

  it('check: `verified: true` is the only yes', async () => {
    for (const body of [
      { verified: false, pinError: 'WRONG_PIN', attemptsRemaining: 4 },
      { verified: false },
      { verified: 'true' },
      {},
    ]) {
      expect(await answer(200, body).verifier.check('PIN123', '123456')).toEqual({
        ok: false,
        reason: 'wrong',
      });
    }
  });

  it.each([
    [200, { verified: false, pinError: 'TTL_EXPIRED' }, 'expired'],
    [200, { verified: false, pinError: 'NO_MORE_PIN_ATTEMPTS', attemptsRemaining: 0 }, 'limited'],
    [404, {}, 'expired'],
    [429, {}, 'limited'],
    [401, {}, 'failed'],
    [500, {}, 'failed'],
  ])('check: HTTP %s %j is "%s"', async (status, body, reason) => {
    const { verifier } = answer(status, body);
    expect(await verifier.check('PIN123', '123456')).toEqual({ ok: false, reason });
  });

  it('a network failure is "failed", never a yes', async () => {
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const verifier = infobipVerifier(KEYS, down);
    expect(await verifier.start('+359888123456', 'bg')).toEqual({ ok: false, reason: 'failed' });
    expect(await verifier.check('PIN123', '123456')).toEqual({ ok: false, reason: 'failed' });
  });

  it('an answer that is not JSON is read by its status alone', async () => {
    const html = (async () =>
      new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    expect(await infobipVerifier(KEYS, html).check('PIN123', '123456')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});
