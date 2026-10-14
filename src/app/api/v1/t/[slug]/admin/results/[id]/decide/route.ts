import { type NextRequest } from 'next/server';

import { decideResultBodySchema } from '@/app-layer/schemas/results';
import { decideResult } from '@/app-layer/usecases/match-results';
import { notifyResultDecided } from '@/app-layer/usecases/result-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/results/{id}/decide (#575, decision 34): the
 * club confirms a result as reported (`{ action: "confirm" }`), confirms a
 * corrected version (`sides`, `score`), or voids it (`{ action: "void" }`).
 * The players are told. Needs `bookings.view_all`.
 *
 * 400 INVALID_SIDES, INVALID_SCORE; 404 for another club's result; 409
 * RESULT_NOT_AWAITING (already counted or voided).
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, decideResultBodySchema, 'decision');
  const { status } = await decideResult({ userId: ctx.userId, tenantId: ctx.tenantId }, id, body);
  await notifyResultDecided({ tenantId: ctx.tenantId, reportId: id });
  return ok({ status });
}

export const POST = defineV1Route(handler);
