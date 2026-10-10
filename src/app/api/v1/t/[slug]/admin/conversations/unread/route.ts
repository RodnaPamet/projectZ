import { type NextRequest } from 'next/server';

import { unreadSummary } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { clubActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/conversations/unread — the club inbox's
 * conversations with a player's message the caller has not read:
 * `{ conversations, requests: 0 }` (a club has no requests).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  return ok(await unreadSummary(clubActor(ctx)));
}

export const GET = defineV1Route(handler);
