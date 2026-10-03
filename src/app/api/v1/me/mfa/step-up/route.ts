import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { mfaCallerFrom, stringField } from '@/app/api/v1/_lib/mfa-caller';
import { stepUp } from '@/lib/auth/mfa';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/mfa/step-up — `{"code":"123456"}` or `{"recoveryCode":"ABCD-…"}`.
 *
 * Proves the second factor on THIS session. For the next 15 minutes
 * (MFA_STEP_UP_WINDOW_SECONDS — fixed, not sliding) this session may perform
 * cross-club writes its grant allows; no other session of the same person
 * may. Every `/api/v1/platform/**` request under a write capability answers
 * 403 STEP_UP_REQUIRED until this succeeds, and again once the window closes.
 *
 * A TOTP code is accepted once: replaying it, even inside its 90-second
 * validity, is refused. A recovery code is spent by the attempt that succeeds.
 * Rate-limited per user — 5 per 15 minutes with a lockout, and 50 a day — and
 * every attempt, refused or not, writes an account_security_event row.
 * `stepUp` binds `runAsSuperuser` itself.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const caller = mfaCallerFrom(req, ctx);

  const body = (await req.json().catch(() => null)) as unknown;
  const code = stringField(body, 'code');
  const recoveryCode = stringField(body, 'recoveryCode');
  if ((code === undefined) === (recoveryCode === undefined)) {
    throw new ValidationError('Send exactly one of `code` or `recoveryCode`', { field: 'code' });
  }

  const stepped = await stepUp(caller, code !== undefined ? { code } : { recoveryCode });
  return ok({
    stepUpExpiresAt: stepped.stepUpExpiresAt.toISOString(),
    method: stepped.method,
    recoveryCodesRemaining: stepped.recoveryCodesRemaining,
  });
}

export const POST = defineV1Route(handler);
