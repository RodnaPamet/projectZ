import { type NextRequest } from 'next/server';

import { readDraw } from '@/app-layer/usecases/tournament-draw';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toDrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/tournaments/{id}/draw (#580): the draw, for signed-in callers
 * (names, as decision 49 has them): groups with tables, the knockout by
 * round, the match for third, each match's court and time and result, and
 * which are the caller's (`mine`). 404 before the draw.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const draw = await readDraw(id, ctx.userId);
  if (!draw) throw new NotFoundError('No draw yet');
  return ok(toDrawDto(draw));
}

export const GET = defineV1Route(handler);
