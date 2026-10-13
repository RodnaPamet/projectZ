import { type NextRequest } from 'next/server';

import { notifyCoachProfileSubmitted } from '@/app-layer/usecases/coach-approval';
import { submitCoachProfile } from '@/app-layer/usecases/coach-profile';
import { asUser } from '@/app/api/v1/_lib/bind';
import { toMyCoachProfile } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/coach-profile/submit
 *
 * Send the caller's coach profile to the platform owner for approval (#545).
 * No body. It needs a text of at least 40 characters, one sport, and an
 * uploaded certificate: 409 `COACH_PROFILE_INCOMPLETE` names what is missing
 * in `details.missing`.
 *
 * From a draft, or after a decline (the earlier decision and its note are
 * cleared: this is a new application). Sending a profile that is already
 * waiting answers 200 with it unchanged; an approved one is 409
 * `COACH_PROFILE_LOCKED`.
 *
 * Until the answer comes the profile cannot be changed; `/withdraw` takes it
 * back. The coach is told the outcome in the bell and by email.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  const { profile, submitted } = await asUser(ctx, (db) => submitCoachProfile(db, userId));
  // After the commit, and only for a submission this call made.
  if (submitted && profile.submittedAt) {
    await notifyCoachProfileSubmitted({ userId, submittedAt: profile.submittedAt });
  }
  return ok(toMyCoachProfile(profile));
}

export const POST = defineV1Route(handler);
