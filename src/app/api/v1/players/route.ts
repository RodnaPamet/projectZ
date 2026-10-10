import { type NextRequest } from 'next/server';

import { findPlayers } from '@/app-layer/usecases/messaging';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { playerActor } from '@/app/api/v1/_lib/messaging';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/players?q= — players by name, for a new conversation (#375).
 * Signed-in players only. At most 20, each the public card: name, picture,
 * sports with levels — never an email, a phone or a booking. Nobody who
 * switched off "Показвай ме в търсенето", and nobody in a block with the
 * caller. Fewer than 2 characters answers an empty list.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const actor = playerActor(ctx);
  const q = req.nextUrl.searchParams.get('q') ?? '';
  if (q.length > 80) throw new ValidationError('`q` is at most 80 characters', { field: 'q' });
  return ok(await findPlayers(actor, q));
}

export const GET = defineV1Route(handler);
