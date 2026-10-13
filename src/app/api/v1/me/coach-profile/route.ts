import { type NextRequest } from 'next/server';

import { myCoachProfile, saveCoachProfile } from '@/app-layer/usecases/coach-profile';
import { asUser } from '@/app/api/v1/_lib/bind';
import { toMyCoachProfile } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/coach-profile   the caller's coach profile as it stands
 * PUT /api/v1/me/coach-profile   save its text and sports
 *
 * A coach's own profile (#545; owner decision 13): a text, the sports and
 * player levels taught, qualifications, and (through `/certificate`) one
 * uploaded certificate, sent to the platform owner for approval through
 * `/submit`.
 *
 * For COACH accounts: any other kind gets 403 `COACH_ACCOUNT_REQUIRED`. A
 * coach who has not started gets `state: "NONE"` and empty fields, not a 404.
 *
 * `missing` names what the profile still needs before it can be sent, and
 * `canEdit` what the state it is in lets the coach change: nothing while it
 * is waiting for a decision (409 `COACH_PROFILE_LOCKED`), the text but not the
 * certificate once approved.
 *
 * PUT replaces the text and the whole list of sports with what is sent. An
 * empty profile is a valid draft. An APPROVED profile must stay complete
 * (409 `COACH_PROFILE_INCOMPLETE`, `details.missing`).
 */
async function getHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  return ok(toMyCoachProfile(await asUser(ctx, (db) => myCoachProfile(db, userId))));
}

async function putHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Body must be a JSON object');
  }
  const saved = await asUser(ctx, (db) =>
    saveCoachProfile(db, userId, {
      bio: body.bio,
      qualifications: body.qualifications,
      sports: body.sports,
    }),
  );
  return ok(toMyCoachProfile(saved));
}

export const GET = defineV1Route(getHandler);
export const PUT = defineV1Route(putHandler);
