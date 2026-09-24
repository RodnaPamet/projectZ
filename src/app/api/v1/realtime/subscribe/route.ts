import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { authorizeSubscription } from '@/lib/realtime/subscribe-authorization';

/**
 * Centrifugo's subscribe proxy.
 *
 * Centrifugo calls this before allowing a client onto a channel. It is the
 * half of the design that `channels.ts` and `mintConnectionToken` were both
 * written against and that nothing implemented: a channel name is an
 * authorization boundary, the token carries no capabilities on purpose, and
 * THIS is where the boundary is actually enforced.
 *
 * ═══ CENTRIFUGO IS THE CALLER, SO A SESSION CANNOT AUTHENTICATE IT ═══
 *
 * This is server-to-server. There is no cookie and no bearer token for a
 * user, because the request is not made by one — Centrifugo is asking on
 * their behalf, and it names the user itself in the body.
 *
 * That makes `user` in the body a claim from the broker, not from the client:
 * Centrifugo derived it from the JWT WE signed and it never passes through
 * the browser. The shared secret is what makes that claim trustworthy, and,
 * exactly as with the cron route, this path sits outside `/api/t/` so no
 * middleware or permission rule covers it. The secret is the whole boundary.
 *
 * Unset means 503, never "no secret configured, therefore allow".
 *
 * ═══ THE RESPONSE SHAPE IS CENTRIFUGO'S, NOT OURS ═══
 *
 * `{"result": {}}` allows and `{"error": {...}}` denies. This is the one
 * place in the codebase that must NOT use the canonical API envelope — the
 * broker parses this, not a client of ours, and an `{error:{code,message}}`
 * body would be read as an allow with unknown fields.
 */
function authorised(req: NextRequest): boolean | null {
  const expected = process.env.CENTRIFUGO_PROXY_SECRET;
  if (!expected) return null;

  const header = req.headers.get('x-centrifugo-secret') ?? '';
  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface ProxyBody {
  user?: unknown;
  channel?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = authorised(req);

  if (auth === null) {
    logger.error('CENTRIFUGO_PROXY_SECRET is not set; refusing every subscription', {
      component: 'realtime',
    });
    return NextResponse.json(
      { error: { code: 503, message: 'proxy not configured' } },
      { status: 200 },
    );
  }

  if (!auth) {
    return NextResponse.json({ error: { code: 403, message: 'forbidden' } }, { status: 200 });
  }

  const body = (await req.json().catch(() => ({}))) as ProxyBody;

  const userId = typeof body.user === 'string' ? body.user : '';
  const channel = typeof body.channel === 'string' ? body.channel : '';

  // An anonymous connection has an empty `user`. Centrifugo allows those by
  // configuration; every channel we issue is personal, so none of them is
  // subscribable without an identity.
  if (!userId || !channel) {
    return NextResponse.json({ error: { code: 403, message: 'forbidden' } }, { status: 200 });
  }

  // Cross-tenant by nature: a person's conversations span every club they
  // belong to, and the broker gave us a user id, not a slug.
  const decision = await runAsSuperuser((db) => authorizeSubscription(db, { userId, channel }));

  if (!decision.allowed) {
    // The reason is logged, never returned. Telling a caller "not a
    // participant" rather than "no such channel" confirms the conversation
    // exists, which is a membership oracle.
    logger.info('subscription denied', { component: 'realtime', reason: decision.reason });
    return NextResponse.json({ error: { code: 403, message: 'forbidden' } }, { status: 200 });
  }

  return NextResponse.json({ result: {} });
}
