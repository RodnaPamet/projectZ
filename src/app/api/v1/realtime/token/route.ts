import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { CONNECTION_TOKEN_TTL, mintConnectionToken } from '@/lib/realtime/centrifugo';

/**
 * A short-lived Centrifugo connection token.
 *
 * `mintConnectionToken` has existed since P15 with no endpoint and no caller,
 * so a native client had no way to connect to realtime at all — the server
 * could publish into channels nobody could subscribe to.
 *
 * ═══ NO TENANT IN THE PATH, DELIBERATELY ═══
 *
 * A connection is per-PERSON, not per-club. Your conversations and your
 * notifications are yours across every club you belong to, and one WebSocket
 * carries all of them — the same reasoning `asUser` already encodes for
 * notifications and wearables. Putting a slug here would mean a connection
 * per club, and a client reconnecting whenever it switched.
 *
 * The consequence is that this path is outside `/api/t/`, so the tenant guard
 * does not apply and `requiredPermission` returns null for it. That is fine
 * here and NOT fine by accident: the handler requires an authenticated user
 * itself, and the token it mints names only that user.
 *
 * ═══ THE TOKEN IS NOT A CAPABILITY ═══
 *
 * It carries `sub` and an expiry. What you may subscribe to is decided per
 * subscription by `/api/v1/realtime/subscribe`, against the database, at the
 * moment you ask. A token minted before you were removed from a conversation
 * therefore does not let you keep reading it — the TTL bounds the connection,
 * not the grant.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  return ok({
    token: mintConnectionToken(ctx.userId),
    // Seconds. The client refreshes before this elapses; a token cannot be
    // revoked, so the TTL IS the revocation window.
    expiresInSeconds: CONNECTION_TOKEN_TTL,
    // Public by definition — the browser and the app both need it to open the
    // socket. Returned here so a client does not need a second config call.
    url: process.env.NEXT_PUBLIC_CENTRIFUGO_URL ?? null,
  });
}

export const POST = defineV1Route(handler);
