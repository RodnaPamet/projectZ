import { type NextRequest } from 'next/server';

import { phoneConfirmBodySchema } from '@/app-layer/schemas/phone';
import { getMe } from '@/app-layer/usecases/me';
import { confirmPhoneVerification } from '@/app-layer/usecases/phone-verification';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/phone/confirm (#500): the code from the SMS, with the number
 * and the `challenge` that `/me/phone/start` answered. On success the number
 * is the account's, and the account is answered as `GET /me`, with
 * `phone.verified: true`.
 *
 * A number confirms one account at a time: 409 PHONE_IN_USE when another
 * account holds it (said only here, after the code proved the caller holds
 * the phone). A no-show standing a deleted account left under the number
 * passes to this account.
 *
 * 400 PHONE_INVALID, PHONE_CODE_WRONG, PHONE_CODE_EXPIRED (also: a challenge
 * that is not this account's, not this number's, altered or too old); 401 UNAUTHORIZED; 409 PHONE_IN_USE; 429 RATE_LIMITED
 * (10 attempts an hour per account); 503 PHONE_VERIFY_UNAVAILABLE.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const { phone, code, challenge } = await parseJsonBody(
    req,
    phoneConfirmBodySchema,
    'phone confirmation',
  );
  await confirmPhoneVerification(ctx.userId, phone, code, challenge);

  const me = await getMe(ctx.userId);
  if (!me) throw new UnauthorizedError('Authentication required');
  return ok(me);
}

export const POST = defineV1Route(handler);
