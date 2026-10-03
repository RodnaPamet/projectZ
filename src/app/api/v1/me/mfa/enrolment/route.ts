import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { mfaCallerFrom } from '@/app/api/v1/_lib/mfa-caller';
import { startEnrolment } from '@/lib/auth/mfa';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/mfa/enrolment — begin enrolling an authenticator (#262).
 *
 * Returns the shared secret ONCE, base32, with the `otpauth://` URI that
 * carries it. The server keeps it only as AES-256-GCM ciphertext. Nothing is
 * switched on until `POST /me/mfa/enrolment/confirm` proves the authenticator
 * produces the right codes.
 *
 * Refused unless the caller holds a live platform grant (403
 * MFA_NOT_ELIGIBLE), signed in within the last 15 minutes (403
 * MFA_REAUTH_REQUIRED), and is not already enrolled (409
 * MFA_ALREADY_ENROLLED — replacing a phone is an operator reset).
 *
 * The response carries a secret, so it must not be cached by anything.
 * `startEnrolment` binds `runAsSuperuser` itself.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const caller = mfaCallerFrom(req, ctx);

  const started = await startEnrolment(caller);
  const res = ok(started);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const POST = defineV1Route(handler);
