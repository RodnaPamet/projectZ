import { type NextRequest } from 'next/server';

import { accountKindBodySchema } from '@/app-layer/schemas/booking-players';
import { chooseAccountKind } from '@/app-layer/usecases/account-kind';
import { getMe } from '@/app-layer/usecases/me';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/account-kind — "Играч или треньор?" (#360, Q13).
 *
 * Body `{ kind: "PLAYER" | "COACH" }`, `.strict()`. A new account is NULL
 * until it chooses; CLUB is never a choice (the owner creates clubs). Answers
 * the account, as `GET /me` does, so a client replaces its copy.
 *
 * ONCE. A second call is 409 ACCOUNT_KIND_ALREADY_SET, whatever it asks for
 * and whatever the account is now: one account, one kind (#263). `PATCH /me`
 * refuses `accountKind` outright, so this is the only write.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const { kind } = await parseJsonBody(req, accountKindBodySchema, 'account kind');
  const done = await chooseAccountKind(ctx.userId, kind);
  if (!done) throw new UnauthorizedError('Authentication required');

  const me = await getMe(ctx.userId);
  if (!me) throw new UnauthorizedError('Authentication required');
  return ok(me);
}

export const POST = defineV1Route(handler);
