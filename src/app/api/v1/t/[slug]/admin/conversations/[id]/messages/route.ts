import { type NextRequest } from 'next/server';

import { sendMessageBodySchema } from '@/app-layer/schemas/messaging';
import { sendMessage } from '@/app-layer/usecases/messaging';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { clubActor, idempotencyKey, messagingId } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/conversations/{id}/messages — answer for the
 * club. The player sees who wrote it («Иван · Тенис клуб Левски»). Same
 * `Idempotency-Key` and limits as a player's send; the limit is the CLUB's,
 * shared by its staff.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  const actor = clubActor(ctx);
  const key = idempotencyKey(req);
  const body = await parseJsonBody(req, sendMessageBodySchema, 'message');
  const sent = await sendMessage(actor, messagingId(id, 'id'), body.body, key);
  return ok(
    { id: sent.id, createdAt: sent.createdAt.toISOString(), replayed: sent.replayed },
    { status: sent.replayed ? 200 : 201 },
  );
}

export const POST = defineV1Route(handler);
