import { type NextRequest } from 'next/server';

import { viewPlayerCard } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { messagingId, playerActor } from '@/app/api/v1/_lib/messaging';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/players/{id} — one player's public card (#375): name, picture,
 * sports with levels. 404 PLAYER_NOT_FOUND for anybody the caller could not
 * write to, exactly as for an id that names nobody.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  return ok(await viewPlayerCard(playerActor(ctx), messagingId(id, 'id')));
}

export const GET = defineV1Route(handler);
