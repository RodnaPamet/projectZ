import { type NextRequest } from 'next/server';

import { phoneStartBodySchema } from '@/app-layer/schemas/phone';
import { startPhoneVerification } from '@/app-layer/usecases/phone-verification';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { chosenLocale } from '@/lib/i18n/chosen-locale';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/phone/start (#500): send an SMS code to the number the
 * signed-in account typed. Then `POST /me/phone/confirm` with the code.
 *
 * Answers `{ sent: true, number, challenge }` (the number with its middle
 * hidden; `challenge` goes back with the code) for any number that can get a
 * code, and says nothing about whether another account holds it: that is
 * answered at confirm, to whoever holds the phone.
 *
 * 400 PHONE_INVALID; 401 UNAUTHORIZED; 429 RATE_LIMITED (5 codes an hour per
 * account; 3 an hour and 6 a day per number, whoever asks); 503
 * PHONE_VERIFY_UNAVAILABLE when no SMS provider is configured or it failed.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const { phone } = await parseJsonBody(req, phoneStartBodySchema, 'phone');
  return ok(await startPhoneVerification(ctx.userId, phone, await chosenLocale()));
}

export const POST = defineV1Route(handler);
