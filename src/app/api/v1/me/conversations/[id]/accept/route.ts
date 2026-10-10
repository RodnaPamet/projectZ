import { type NextRequest } from 'next/server';

import { acceptRequest } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/conversations/{id}/accept — accept a request in «Заявки»:
 * from now on both may write. Idempotent. 409 NOT_A_REQUEST for anything that
 * is not a request to the caller.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const r = await acceptRequest(playerActor(ctx), messagingId(id, 'id'));
  return ok({ acceptedAt: r.acceptedAt.toISOString() });
}

export const POST = defineV1Route(handler);
