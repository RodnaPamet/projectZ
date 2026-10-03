import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { mfaCallerFrom } from '@/app/api/v1/_lib/mfa-caller';
import { regenerateRecoveryCodes } from '@/lib/auth/mfa';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/mfa/recovery-codes — a new set of ten, replacing every old one.
 *
 * Needs a fresh step-up on this session (403 STEP_UP_REQUIRED otherwise): a
 * fresh set of codes is as good as the phone, so it is guarded like a
 * cross-club write. Shown once, in this response. `regenerateRecoveryCodes`
 * binds `runAsSuperuser` itself.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const caller = mfaCallerFrom(req, ctx);

  const issued = await regenerateRecoveryCodes(caller);
  const res = ok(issued);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const POST = defineV1Route(handler);
