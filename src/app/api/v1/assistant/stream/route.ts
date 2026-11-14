import { getToken } from 'next-auth/jwt';
import { type NextRequest } from 'next/server';

import { AssistantAskSchema } from '@/app-layer/schemas/assistant';
import { prepareAsk, streamAsk } from '@/app-layer/usecases/assistant-ask';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { ASSISTANT_ASK_LIMIT } from '@/lib/security/rate-limit';

/**
 * POST /api/v1/assistant/stream — ask «Асистент» (owner 2026-11-14, #704).
 *
 * Body `{ message, conversationId?, page?, location? }` (AssistantAskSchema).
 * Answers `text/event-stream`: `data: <json>\n\n` events, switched on their
 * `type` — conversation, thinking, tool_call, tool_result, answer, refusal,
 * halt, done (src/app-layer/ai/assistant/stream-events.ts). Read to `done`,
 * also after a `halt`.
 *
 * Before the stream opens, ordinary JSON errors: 401 signed out, 404
 * `ASSISTANT_DISABLED` (hide the launcher), 403 `ASSISTANT_PLAYERS_ONLY`,
 * 400 for the body, 429 for the rate limit. After it opens, every ending is
 * an event: the response is already a 200.
 *
 * No route-level permission: the assistant reads nothing a route would gate.
 * Each tool reads through a use case scoped to the caller, and the database
 * work is bound there (runAsUserOnly as the caller; the public venue reads and
 * the players of the caller's own booking as the use cases document).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 20_000;

async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;

  const { locale } = await prepareAsk(userId);
  const ask = await parseJsonBody(req, AssistantAskSchema, 'question');

  const controller = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          sink.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (closed) return;
        closed = true;
        try {
          sink.close();
        } catch {
          // already closed by the client
        }
      };
      // A comment line keeps proxies from closing a quiet connection.
      heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS);
      void streamAsk({ userId, locale, ask, send, signal: controller.signal }).finally(finish);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
    },
  });
  req.signal.addEventListener('abort', () => controller.abort());

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}

export const POST = defineV1Route(handler, {
  rateLimit: {
    config: ASSISTANT_ASK_LIMIT,
    scope: 'assistant-ask',
    getUserId: async (req) => (await getToken({ req, secret: process.env.NEXTAUTH_SECRET }))?.sub,
  },
});
