import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { mfaCallerFrom, stringField } from '@/app/api/v1/_lib/mfa-caller';
import { confirmEnrolment } from '@/lib/auth/mfa';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/mfa/enrolment/confirm — `{"code":"123456"}`.
 *
 * The first code from the new authenticator. On success two-step verification
 * is on, THIS session is stepped up (the caller just proved the factor), and
 * the response carries ten recovery codes — the only time they are ever shown.
 * The server keeps their SHA-256 only.
 *
 * Rate-limited per user (10 per 15 minutes). A wrong code is 403
 * MFA_CODE_REJECTED and is recorded. `confirmEnrolment` binds
 * `runAsSuperuser` itself.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const caller = mfaCallerFrom(req, ctx);

  const body = (await req.json().catch(() => null)) as unknown;
  const code = stringField(body, 'code');
  if (!code) throw new ValidationError('`code` is required', { field: 'code' });

  const confirmed = await confirmEnrolment(caller, code);
  const res = ok({
    recoveryCodes: confirmed.recoveryCodes,
    stepUpExpiresAt: confirmed.stepUpExpiresAt.toISOString(),
  });
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const POST = defineV1Route(handler);
