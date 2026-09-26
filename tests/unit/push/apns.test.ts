import { generateKeyPairSync } from 'node:crypto';

import {
  mintProviderToken,
  resetProviderTokenCache,
  sendApns,
  type ApnsTransport,
} from '@/lib/push/apns';

/**
 * APNs, against a mocked transport.
 *
 * The transport is injected rather than the module stubbed, so these assert
 * what actually goes over the wire — the topic, the priority, the path, the
 * bearer token — the same reasoning the MSW helper gives for intercepting HTTP
 * rather than stubbing the Stripe SDK.
 *
 * What they CANNOT prove is that Apple accepts any of it. That needs real
 * credentials and a real device. Said plainly here rather than implied by a
 * row of green ticks.
 */

// A real EC P-256 key, generated per run. The signature format matters (see
// below) and a fake string would not exercise it.
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const DEVICE = {
  deviceToken: 'a'.repeat(64),
  bundleId: 'bg.playerz.app',
  environment: 'PRODUCTION' as const,
};

const PAYLOAD = { title: 'Booking confirmed', body: 'Court 1 at 09:00' };

function recordingTransport(response: { status: number; reason?: string }) {
  const calls: Array<{ host: string; headers: Record<string, string | number>; body: string }> = [];
  const transport: ApnsTransport = {
    async request(host, headers, body) {
      calls.push({ host, headers, body });
      return response;
    },
  };
  return { transport, calls };
}

beforeEach(() => {
  resetProviderTokenCache();
  process.env.APNS_KEY_ID = 'ABC123DEFG';
  process.env.APNS_TEAM_ID = 'TEAM123456';
  process.env.APNS_PRIVATE_KEY = privateKey as string;
});

describe('provider token', () => {
  it('is a three-part JWT naming the key and the team', () => {
    const jwt = mintProviderToken()!;
    const [header, claims] = jwt.split('.');

    expect(jwt.split('.')).toHaveLength(3);
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'ABC123DEFG',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss).toBe('TEAM123456');
  });

  it('signs with a RAW r‖s signature, not DER', () => {
    // Node emits DER for EC by default. `crypto.sign` accepts it, and Apple
    // rejects it as a malformed token — an auth failure that reads like a
    // wrong key. A P-256 ieee-p1363 signature is exactly 64 bytes; a DER one
    // is ~70 and starts with 0x30.
    const sig = Buffer.from(mintProviderToken()!.split('.')[2]!, 'base64url');

    expect(sig).toHaveLength(64);
    expect(sig[0]).not.toBe(0x30);
  });

  it('is CACHED — Apple rejects providers that mint too often', () => {
    // `TooManyProviderTokenUpdates`. Minting per push works in development and
    // fails under real traffic, which is the worst place to find out.
    const first = mintProviderToken(1_000_000);
    const soonAfter = mintProviderToken(1_000_000 + 60_000);

    expect(soonAfter).toBe(first);
  });

  it('mints a fresh one once the window has passed', () => {
    const first = mintProviderToken(1_000_000);
    const later = mintProviderToken(1_000_000 + 51 * 60 * 1000);

    expect(later).not.toBe(first);
  });

  it('returns null rather than throwing when unconfigured', () => {
    // Push is an enhancement. Missing credentials must disable it, not throw
    // into whatever was trying to notify somebody.
    delete process.env.APNS_KEY_ID;
    resetProviderTokenCache();

    expect(mintProviderToken()).toBeNull();
  });
});

describe('sendApns', () => {
  it('posts to the device path with the topic and an immediate priority', async () => {
    const { transport, calls } = recordingTransport({ status: 200 });

    await sendApns(DEVICE, PAYLOAD, { transport });

    const [call] = calls;
    expect(call!.host).toBe('https://api.push.apple.com');
    expect(call!.headers[':path']).toBe(`/3/device/${DEVICE.deviceToken}`);
    expect(call!.headers['apns-topic']).toBe('bg.playerz.app');
    // 10 = deliver now. 5 lets Apple batch for battery, which is wrong for
    // "your court is confirmed".
    expect(call!.headers['apns-priority']).toBe(10);
    expect(String(call!.headers.authorization)).toMatch(/^bearer /);
  });

  it('sends SANDBOX to the sandbox host', async () => {
    // Different host, different token namespace. Getting this wrong is the
    // classic "works in TestFlight, not in the App Store".
    const { transport, calls } = recordingTransport({ status: 200 });

    await sendApns({ ...DEVICE, environment: 'SANDBOX' }, PAYLOAD, { transport });

    expect(calls[0]!.host).toBe('https://api.sandbox.push.apple.com');
  });

  it('builds an aps payload Apple will render', async () => {
    const { transport, calls } = recordingTransport({ status: 200 });

    await sendApns(
      DEVICE,
      { ...PAYLOAD, threadId: 'booking-1', url: '/bookings/1' },
      { transport },
    );

    const body = JSON.parse(calls[0]!.body) as Record<string, never>;
    expect(body).toMatchObject({
      aps: {
        alert: { title: 'Booking confirmed', body: 'Court 1 at 09:00' },
        'thread-id': 'booking-1',
      },
      url: '/bookings/1',
    });
  });

  it.each([
    // Provider misconfiguration, NOT a device verdict. The topic is identical
    // for every device in a fan-out, so classifying these as permanent meant
    // one wrong bundle id deleted every registration it touched — and these
    // two were the only members of PERMANENT with no test.
    ['BadTopic', 400],
    ['TopicDisallowed', 400],
    // Observed for real against sandbox with a production-only key (#166).
    ['BadEnvironmentKeyInToken', 403],
  ])('treats %s as OUR misconfiguration — keep the row, flag it', async (reason, status) => {
    const { transport } = recordingTransport({ status, reason });

    await expect(sendApns(DEVICE, PAYLOAD, { transport })).resolves.toMatchObject({
      ok: false,
      gone: false,
      configError: true,
      reason,
    });
  });

  it('a malformed signing key is an outcome, not a throw', async () => {
    // crypto.sign THROWS on a PEM OpenSSL cannot decode. Unguarded that escaped
    // sendApns, rejected inside the caller's Promise.all and rolled back the
    // enclosing transaction — discarding the notification row that had already
    // been written, against the module's "persist, then push" contract.
    const saved = process.env.APNS_PRIVATE_KEY;
    // Not a key. PEM armour wrapped around the literal text "not-base64",
    // which is exactly what OpenSSL's decoder refuses.
    process.env.APNS_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\nnot-base64\n-----END PRIVATE KEY-----'; // pragma: allowlist secret
    resetProviderTokenCache();

    const { transport, calls } = recordingTransport({ status: 200 });
    try {
      await expect(sendApns(DEVICE, PAYLOAD, { transport })).resolves.toMatchObject({
        ok: false,
        gone: false,
        configError: true,
      });
      // Nothing should have been attempted against Apple.
      expect(calls).toHaveLength(0);
    } finally {
      process.env.APNS_PRIVATE_KEY = saved;
      resetProviderTokenCache();
    }
  });

  it.each([
    ['BadDeviceToken', 400],
    ['Unregistered', 410],
    ['DeviceTokenNotForTopic', 400],
  ])('treats %s as PERMANENT — delete the row', async (reason, status) => {
    // Retrying these forever is not just wasted work: failures pile up behind
    // tokens that will never accept anything, and genuine notifications queue
    // behind them.
    const { transport } = recordingTransport({ status, reason });

    await expect(sendApns(DEVICE, PAYLOAD, { transport })).resolves.toMatchObject({
      ok: false,
      gone: true,
    });
  });

  it.each([429, 500, 503])('treats %s as TRANSIENT — keep the row', async (status) => {
    // Deleting on these would silently unsubscribe a user whose device had a
    // bad afternoon, and they would never learn why push stopped.
    const { transport } = recordingTransport({ status, reason: 'TooManyRequests' });

    await expect(sendApns(DEVICE, PAYLOAD, { transport })).resolves.toMatchObject({
      ok: false,
      gone: false,
    });
  });

  it('treats a bare 410 as gone even with no reason in the body', async () => {
    const { transport } = recordingTransport({ status: 410 });

    await expect(sendApns(DEVICE, PAYLOAD, { transport })).resolves.toMatchObject({
      ok: false,
      gone: true,
    });
  });

  it('a transport failure is transient, never permanent', async () => {
    // The device has done nothing wrong; our socket did.
    const transport: ApnsTransport = {
      async request() {
        throw new Error('APNs request timed out');
      },
    };

    await expect(sendApns(DEVICE, PAYLOAD, { transport })).resolves.toMatchObject({
      ok: false,
      gone: false,
    });
  });

  it('does not delete devices when WE are the ones misconfigured', async () => {
    // No credentials is our problem, not the device's. Reporting `gone` here
    // would wipe every registration in the database on a bad deploy.
    delete process.env.APNS_TEAM_ID;
    resetProviderTokenCache();
    const { transport, calls } = recordingTransport({ status: 200 });

    const outcome = await sendApns(DEVICE, PAYLOAD, { transport });

    expect(outcome).toMatchObject({ ok: false, gone: false, reason: 'not-configured' });
    expect(calls).toHaveLength(0);
  });
});
