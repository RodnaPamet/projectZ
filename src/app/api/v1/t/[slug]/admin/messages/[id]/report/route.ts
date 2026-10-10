import { type NextRequest } from 'next/server';

import { reportBodySchema } from '@/app-layer/schemas/messaging';
import { reportMessage } from '@/app-layer/usecases/messaging';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { clubActor, messagingId } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/messages/{id}/report — the club's staff report a
 * player's message to the platform's moderators (#375). Not the club's own
 * replies.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  const actor = clubActor(ctx);
  const body = await parseJsonBody(req, reportBodySchema, 'report');
  return ok(await reportMessage(actor, messagingId(id, 'id'), body), { status: 201 });
}

export const POST = defineV1Route(handler);
