import { type NextRequest } from 'next/server';

import { retractMessage } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { clubActor, messagingId } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/t/{slug}/admin/messages/{id} — retract one of the caller's
 * own replies. Only the person who wrote it: a colleague's words are not
 * theirs to unsay.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  return ok(await retractMessage(clubActor(ctx), messagingId(id, 'id')));
}

export const DELETE = defineV1Route(handler);
