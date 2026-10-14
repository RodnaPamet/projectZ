import { type NextRequest } from 'next/server';

import { openEntryCheckout } from '@/app-layer/usecases/tournament-payments';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/tournament-entries/{id}/checkout (#581, decision 64): a page
 * on Stripe's hosted checkout for an entry's fee, paid on sign-up. Only the
 * entrant pays. A new page each time, with a new deadline; until it is paid
 * the club does not see the entry and it holds no place.
 *
 * 404 TOURNAMENT_PAYMENT_NOT_DUE (not the caller's entry); 409
 * TOURNAMENT_PAYMENT_NOT_DUE (nothing to pay), TOURNAMENT_ONLINE_FEE_UNAVAILABLE.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const { checkoutUrl, dueBy } = await openEntryCheckout(ctx.userId, id);
  return ok({ checkoutUrl, dueBy: dueBy.toISOString() }, { status: 201 });
}

export const POST = defineV1Route(handler);
