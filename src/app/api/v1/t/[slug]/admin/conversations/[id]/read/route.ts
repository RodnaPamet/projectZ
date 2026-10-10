import { type NextRequest } from 'next/server';

import { markConversationRead } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { clubActor, messagingId } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/conversations/{id}/read — the caller has read
 * the conversation. Their OWN pointer: a colleague's unread count is theirs.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  const r = await markConversationRead(clubActor(ctx), messagingId(id, 'id'));
  return ok({ readAt: r.readAt.toISOString() });
}

export const POST = defineV1Route(handler);
