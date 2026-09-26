import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { sign } from 'node:crypto';

/**
 * Apple Push Notification service.
 *
 * ═══ WHY THIS DOES NOT USE fetch ═══
 *
 * APNs is HTTP/2 only, and Node's built-in `fetch` (undici) speaks HTTP/1.1.
 * So the pattern used for Stripe and Microsoft Graph does not transfer — this
 * talks to `node:http2` directly rather than pulling in a dependency for it.
 *
 * ═══ THE PROVIDER TOKEN IS CACHED, AND THAT IS NOT AN OPTIMISATION ═══
 *
 * Apple rejects providers that mint tokens too often, with
 * `TooManyProviderTokenUpdates`. A token is valid for an hour; minting one per
 * push would work in development and start failing under real traffic, which
 * is the worst possible place to discover it.
 *
 * So it is minted at most every 50 minutes. The cache is keyed by nothing —
 * there is one signing key per app.
 *
 * ═══ ES256 SIGNATURES ARE RAW, NOT DER ═══
 *
 * Node's EC signing emits DER by default. A JWT needs the raw r‖s pair, and a
 * DER signature is silently accepted by `crypto.sign` and silently REJECTED by
 * Apple as a malformed token — an authentication failure that looks like a
 * wrong key. `dsaEncoding: 'ieee-p1363'` is what makes it a JWT signature.
 */

const HOSTS = {
  PRODUCTION: 'https://api.push.apple.com',
  SANDBOX: 'https://api.sandbox.push.apple.com',
} as const;

export type ApnsEnvironment = keyof typeof HOSTS;

/** Apple's tokens last an hour; refresh well inside that. */
const TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ApnsPayload {
  title: string;
  body: string;
  /** Groups notifications in the shade, like Web Push's `tag`. */
  threadId?: string;
  badge?: number;
  /** Deep link, carried in the custom payload for the app to route on. */
  url?: string;
}

/**
 * Deliberately the same shape as `PushOutcome` in ./send.ts, so the
 * notification fan-out treats both transports uniformly instead of branching.
 */
export type ApnsOutcome =
  | { ok: true }
  /** The token is DEAD. Delete the row — Apple will never accept it again. */
  | { ok: false; gone: true; reason: string }
  /** Transient. Keep the row and try again. */
  | { ok: false; gone: false; status?: number; reason?: string; configError?: true };

/**
 * Apple's permanent rejections.
 *
 * These mean the app was uninstalled, the token was reissued, or it belongs to
 * a different environment. Retrying any of them forever is not merely wasted
 * work — the failures pile up behind tokens that will never accept anything,
 * and the genuine notifications queue behind them.
 *
 * Everything else (429, 5xx, a timeout) is transient, and deleting on those
 * would silently unsubscribe a user whose device had a bad afternoon.
 */
const PERMANENT = new Set([
  'BadDeviceToken',
  'Unregistered',
  // A token minted for a DIFFERENT topic than the one it is being sent under.
  // Unlike the two below, this is a verdict about THIS token: it will never be
  // valid for this app, so the row is genuinely dead.
  'DeviceTokenNotForTopic',
]);

/**
 * Apple rejecting US, not the device. NEVER delete a row for one of these.
 *
 * ═══ WHY BadTopic AND TopicDisallowed MOVED OUT OF `PERMANENT` ═══
 *
 * They were in it, and that was a mistake with a very large blast radius.
 * Neither says anything about the device. `BadTopic` means the `apns-topic`
 * header is not a topic this key may use; `TopicDisallowed` means the key lacks
 * the entitlement. The topic is IDENTICAL for every device in a fan-out, so the
 * failure is not per-device — one wrong bundle id returned `gone: true` for
 * every device it touched, and `notifications.ts` deleted all of them.
 *
 * A misconfiguration therefore destroyed the registration table rather than
 * failing a send, and recovery was not automatic: every user had to reopen the
 * app to re-register. The two entries that were wrong were also the only two in
 * the set with no test.
 *
 * `BadEnvironmentKeyInToken` is here for the same reason, and was observed for
 * real: the signing key is enabled for production only, so every sandbox send
 * returns it (#166). The device is blameless; the key is wrong.
 *
 * These stay transient so the row survives — but transient and SILENT is how a
 * misconfiguration retries forever with nothing reporting why, so the caller is
 * expected to log `configError` at error level.
 */
const CONFIG_ERROR = new Set(['BadTopic', 'TopicDisallowed', 'BadEnvironmentKeyInToken']);

let cachedToken: { jwt: string; mintedAt: number } | null = null;

export function mintProviderToken(now = Date.now()): string | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;

  // Push is an enhancement. Missing credentials disable it rather than
  // throwing into whatever was trying to notify somebody.
  if (!keyId || !teamId || !privateKey) return null;

  if (cachedToken && now - cachedToken.mintedAt < TOKEN_TTL_MS) {
    return cachedToken.jwt;
  }

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'ES256', kid: keyId });
  const claims = b64({ iss: teamId, iat: Math.floor(now / 1000) });
  const signingInput = `${header}.${claims}`;

  const signature = sign('sha256', Buffer.from(signingInput), {
    // The .p8 Apple issues is PKCS#8 PEM. Newlines survive an env var badly,
    // so `\n` escapes are accepted and restored.
    key: privateKey.replace(/\\n/g, '\n'),
    // See the header comment: DER here is accepted locally and rejected by
    // Apple as a malformed token.
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  const jwt = `${signingInput}.${signature}`;
  cachedToken = { jwt, mintedAt: now };
  return jwt;
}

/** Only for tests — the cache is otherwise process-lifetime. */
export function resetProviderTokenCache(): void {
  cachedToken = null;
}

export interface ApnsTransport {
  request(
    host: string,
    headers: Record<string, string | number>,
    body: string,
  ): Promise<{ status: number; reason?: string }>;
}

/** The real transport. Injectable so a test can assert what goes over the wire. */
export const http2Transport: ApnsTransport = {
  async request(host, headers, body) {
    const session: ClientHttp2Session = connect(host);

    try {
      return await new Promise((resolve, reject) => {
        // Without this, a connection-level failure is an 'error' event with no
        // listener. The stream listener below still rejects first, so the
        // OUTCOME was always correct — but the unhandled event was left to the
        // host process to absorb, and borrowing a safety property from Next's
        // uncaughtException handler is not the same as having one.
        session.on('error', reject);

        const timer = setTimeout(() => {
          stream.close(constants.NGHTTP2_CANCEL);
          reject(new Error('APNs request timed out'));
        }, REQUEST_TIMEOUT_MS);

        const stream = session.request(headers);
        let status = 0;
        let raw = '';

        stream.on('response', (h) => {
          status = Number(h[':status'] ?? 0);
        });
        stream.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        stream.on('end', () => {
          clearTimeout(timer);
          let reason: string | undefined;
          try {
            reason = (JSON.parse(raw) as { reason?: string }).reason;
          } catch {
            // A 200 has an empty body; only failures carry JSON.
          }
          resolve({ status, reason });
        });
        stream.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        stream.end(body);
      });
    } finally {
      // `destroy()`, not `close()`. `close()` is a GRACEFUL shutdown: it sends
      // GOAWAY and waits, and it cannot cancel a TCP connect that has not
      // completed. Against a blackholed address the request timed out at 5 s
      // and returned a clean transient outcome while the socket stayed open
      // holding the event loop, until the OS gave up ~73 s later and the
      // session emitted a connect error long after the request it belonged to
      // had been logged as a normal retry.
      session.destroy();
    }
  },
};

export async function sendApns(
  device: { deviceToken: string; bundleId: string; environment: ApnsEnvironment },
  payload: ApnsPayload,
  deps: { transport?: ApnsTransport; now?: () => number } = {},
): Promise<ApnsOutcome> {
  const transport = deps.transport ?? http2Transport;

  // `crypto.sign` THROWS on a PEM OpenSSL cannot decode — it does not return
  // null. Unguarded, that escaped sendApns, rejected inside the caller's
  // Promise.all and rolled back the enclosing transaction, discarding the
  // notification row that `notify` had already written. The module's contract
  // is "persist, then push"; a bad credential must not undo the persist.
  let token: string | null;
  try {
    token = mintProviderToken(deps.now?.() ?? Date.now());
  } catch (err) {
    return {
      ok: false,
      gone: false,
      configError: true,
      reason: `bad-signing-key: ${(err as Error).message}`,
    };
  }

  if (!token) {
    // Not configured. Transient rather than gone — the device is fine, we are
    // the ones who cannot send.
    return { ok: false, gone: false, reason: 'not-configured' };
  }

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      ...(payload.threadId ? { 'thread-id': payload.threadId } : {}),
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    },
    ...(payload.url ? { url: payload.url } : {}),
  });

  try {
    const res = await transport.request(
      HOSTS[device.environment],
      {
        ':method': 'POST',
        ':path': `/3/device/${device.deviceToken}`,
        authorization: `bearer ${token}`,
        // The bundle id. A token is only valid for the topic it was issued to.
        'apns-topic': device.bundleId,
        'apns-push-type': 'alert',
        // 10 = deliver immediately. 5 would let Apple batch for battery, which
        // is wrong for "your court is confirmed".
        'apns-priority': 10,
        'content-type': 'application/json',
      },
      body,
    );

    if (res.status === 200) return { ok: true };

    // Checked BEFORE PERMANENT so a provider-level reason can never be read as
    // a device verdict, whatever else it might also match.
    if (res.reason && CONFIG_ERROR.has(res.reason)) {
      return {
        ok: false,
        gone: false,
        status: res.status,
        reason: res.reason,
        configError: true,
      };
    }

    if (res.reason && PERMANENT.has(res.reason)) {
      return { ok: false, gone: true, reason: res.reason };
    }

    // 410 is Apple's "this token is no longer active", with or without a body.
    if (res.status === 410) {
      return { ok: false, gone: true, reason: res.reason ?? 'Unregistered' };
    }

    return { ok: false, gone: false, status: res.status, reason: res.reason };
  } catch (err) {
    // A timeout or a transport failure. Never permanent — the device has done
    // nothing wrong.
    return { ok: false, gone: false, reason: (err as Error).message };
  }
}
