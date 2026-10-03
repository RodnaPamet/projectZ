import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { mfaCallerFrom } from '@/app/api/v1/_lib/mfa-caller';
import { getMfaStatus } from '@/lib/auth/mfa';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/mfa — the caller's second factor, and this session's step-up.
 *
 * `stepUpExpiresAt` is for THIS session only: a step-up is bound to the
 * session that made it (#262), so the phone and the laptop each have their
 * own. Null when this session has none that still counts.
 *
 * Reads through `getMfaStatus`, which binds `runAsSuperuser` itself: the
 * tables it reads (app_user's MFA columns, mfa_recovery_code) deny app_user.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const caller = mfaCallerFrom(req, ctx);

  const status = await getMfaStatus(caller);
  return ok({
    eligible: status.eligible,
    enrolled: status.enrolled,
    pending: status.pending,
    stepUpExpiresAt: status.stepUpExpiresAt?.toISOString() ?? null,
    recoveryCodesRemaining: status.recoveryCodesRemaining,
  });
}

export const GET = defineV1Route(handler);
