import { type NextRequest } from 'next/server';

import { endMyLink, myCoachLinks, saveTeachingTerms } from '@/app-layer/usecases/coach-links';
import { toMyCoachLinks } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * PUT    /api/v1/me/coach-links/{id}   the coach's terms at that venue
 * DELETE /api/v1/me/coach-links/{id}   end it, or take a request back
 *
 * One of the caller's own links (#546). Another coach's id, or one that does
 * not exist, is 404 `COACH_LINK_NOT_FOUND`: the two are not told apart.
 *
 * PUT sets what the coach charges and teaches there (owner decisions 2, 5, 6
 * and 9), all four together:
 *
 *   hourlyRateCents     required, 0 to 100000, per hour, for one player
 *   groupRateCents      optional; for two or more players. Null or absent:
 *                       no group lessons at this venue
 *   lessonMinutes       one or more of the link's `lengthOptions`, the
 *                       lengths the venue's courts are booked for
 *   cancelCutoffHours   0 to 168: how long before a lesson a player may still
 *                       cancel. Default 24. A lesson follows the stricter of
 *                       this and the club's own.
 *
 * Only for an `ACTIVE` link (409 `COACH_LINK_STATE`, `details.status`). A
 * field that is wrong is 400 `VALIDATION_ERROR` with `details.field` and
 * `details.reason`. The club's audit log records the change.
 *
 * DELETE ends a `REQUESTED` or `ACTIVE` link from the coach's side. Lessons
 * already booked stay until they are cancelled; no new ones can be booked.
 * The weekly hours there are deleted. An ended or declined link is 409
 * `COACH_LINK_STATE`.
 *
 * Both answer with the whole list.
 */
async function putHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Body must be a JSON object');
  }
  await saveTeachingTerms(ctx.userId, id, {
    hourlyRateCents: body.hourlyRateCents,
    groupRateCents: body.groupRateCents,
    lessonMinutes: body.lessonMinutes,
    cancelCutoffHours: body.cancelCutoffHours,
  });
  return ok(toMyCoachLinks(await myCoachLinks(ctx.userId)));
}

async function deleteHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  await endMyLink(ctx.userId, id);
  return ok(toMyCoachLinks(await myCoachLinks(ctx.userId)));
}

export const PUT = defineV1Route(putHandler);
export const DELETE = defineV1Route(deleteHandler);
