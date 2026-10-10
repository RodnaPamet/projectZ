import { type NextRequest } from 'next/server';

import { reportBodySchema } from '@/app-layer/schemas/messaging';
import { reportMessage } from '@/app-layer/usecases/messaging';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/messages/{id}/report — report a message to the platform's
 * moderators (#375): `{ reason, details? }`. One case per message however many
 * report it; the sender is not told. Not one's own message.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const actor = playerActor(ctx);
  const body = await parseJsonBody(req, reportBodySchema, 'report');
  return ok(await reportMessage(actor, messagingId(id, 'id'), body), { status: 201 });
}

export const POST = defineV1Route(handler);
