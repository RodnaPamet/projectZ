import { type NextRequest } from 'next/server';

import { unreadSummary } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/conversations/unread — how much is waiting (#375):
 * `{ conversations, requests }`, each the number of conversations with
 * something unread. The header's messages icon shows their sum.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  return ok(await unreadSummary(playerActor(ctx)));
}

export const GET = defineV1Route(handler);
