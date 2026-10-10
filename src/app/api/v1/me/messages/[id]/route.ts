import { type NextRequest } from 'next/server';

import { retractMessage } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/messages/{id} — retract one of the caller's own messages.
 * A tombstone keeps its place in the other side's scrollback; its text is
 * gone. Idempotent.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  return ok(await retractMessage(playerActor(ctx), messagingId(id, 'id')));
}

export const DELETE = defineV1Route(handler);
