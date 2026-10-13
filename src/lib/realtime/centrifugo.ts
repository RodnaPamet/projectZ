import { createHmac } from 'node:crypto';

/**
 * Centrifugo server API + connection-token minting.
 *
 * ─── publish() NEVER throws ──────────────────────────────────────────
 *
 * Centrifugo is a delivery mechanism, not the source of truth. A publish
 * failure means "this message will arrive on the next fetch or on reconnect
 * via channel history" — it does not mean the message is lost, because it is
 * already in Postgres.
 *
 * Letting a publish failure propagate would roll back a legitimate message
 * because a WEBSOCKET BROKER was restarting. That is an absurd way to lose a
 * write, and it turns a degraded-realtime incident into a total outage of
 * chat.
 */

const API_URL = () => process.env.CENTRIFUGO_API_URL ?? 'http://localhost:8000/api';
const API_KEY = () => process.env.CENTRIFUGO_API_KEY ?? '';
const TOKEN_SECRET = () => process.env.CENTRIFUGO_TOKEN_SECRET ?? '';

/** Seconds. Short-lived on purpose — see below. */
export const CONNECTION_TOKEN_TTL = 15 * 60;

/**
 * Mint a connection JWT.
 *
 * SHORT-LIVED (15 min), and the client refreshes. A long-lived token cannot be
 * revoked: block a user, or remove them from a venue, and a token minted an
 * hour ago still lets them hold their subscription open. The TTL is the
 * revocation window.
 *
 * The token carries `sub` (who you are) and nothing else. It is NOT a
 * capability list — channel authorization is decided per-subscription by the
 * server, against the database, at subscribe time. Putting channel grants in
 * the token would freeze them for the token's lifetime, which is exactly the
 * bug the short TTL exists to bound.
 */
export function mintConnectionToken(userId: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: userId, iat, exp: iat + CONNECTION_TOKEN_TTL };

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = createHmac('sha256', TOKEN_SECRET()).update(signingInput).digest('base64url');

  return `${signingInput}.${sig}`;
}

export interface PublishResult {
  delivered: boolean;
  /** True when Centrifugo was unreachable. The message IS still persisted. */
  degraded: boolean;
}

export async function publish(channel: string, data: unknown): Promise<PublishResult> {
  try {
    const res = await fetch(API_URL(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Centrifugo v6 expects the API key in an Authorization header.
        Authorization: `apikey ${API_KEY()}`,
      },
      body: JSON.stringify({ method: 'publish', params: { channel, data } }),
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) return { delivered: false, degraded: true };
    return { delivered: true, degraded: false };
  } catch {
    // Swallowed BY DESIGN. See the header note: the message is already in
    // Postgres, and a broker restart must not fail the write.
    return { delivered: false, degraded: true };
  }
}

/** Channel history — how a reconnecting client recovers what it missed. */
export async function history(channel: string, limit = 100): Promise<unknown[]> {
  try {
    const res = await fetch(API_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `apikey ${API_KEY()}` },
      body: JSON.stringify({ method: 'history', params: { channel, limit } }),
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) return [];
    const json = (await res.json()) as { result?: { publications?: Array<{ data: unknown }> } };
    return (json.result?.publications ?? []).map((p) => p.data);
  } catch {
    return [];
  }
}

/**
 * Is chat push on in this deployment (#481)? Both secrets set: the app can
 * sign a connection token and can publish. Otherwise the browser is never
 * told to connect, and chat keeps re-reading on its own interval.
 */
export function realtimeEnabled(): boolean {
  return !!process.env.CENTRIFUGO_TOKEN_SECRET && !!process.env.CENTRIFUGO_API_KEY;
}

/**
 * Where a browser connects: the deployment's own origin, through Caddy, so
 * staging and production each point at their own broker with the same image.
 * Null when push is off.
 */
export function publicSocketUrl(): string | null {
  if (!realtimeEnabled()) return null;
  const origin = process.env.NEXTAUTH_URL;
  if (!origin) return null;
  try {
    const url = new URL('/connection/websocket', origin);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Publish one event to several channels at once (Centrifugo's `broadcast`).
 * Never throws, for the same reason `publish` doesn't: the data is already in
 * Postgres, and a broker restart must not fail the write. A no-op when push
 * is off.
 */
export async function broadcast(channels: string[], data: unknown): Promise<PublishResult> {
  if (!realtimeEnabled() || channels.length === 0) return { delivered: false, degraded: false };
  try {
    const res = await fetch(API_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `apikey ${API_KEY()}` },
      body: JSON.stringify({ method: 'broadcast', params: { channels, data } }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { delivered: false, degraded: true };
    return { delivered: true, degraded: false };
  } catch {
    return { delivered: false, degraded: true };
  }
}
