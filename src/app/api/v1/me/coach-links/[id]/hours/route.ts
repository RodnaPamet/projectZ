import { type NextRequest } from 'next/server';

import { myCoachLinks, saveTeachingHours } from '@/app-layer/usecases/coach-links';
import { toMyCoachLinks } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * PUT /api/v1/me/coach-links/{id}/hours
 * body: { hours: [{ dayOfWeek, open, close }] }
 *
 * The weekly hours the caller teaches at that venue (#546; owner decision
 * 14), replacing the week that was there. `dayOfWeek` is 0 = Sunday to
 * 6 = Saturday, as the courts' own hours are; `open` and `close` are `HH:MM`
 * in the venue's time, on the quarter hour, the same day (the latest close is
 * 23:45). Up to four stretches a day; two may touch, none may overlap. An
 * empty list is valid: no regular hours here, so no lesson can be booked.
 *
 * Days off are separate and apply at every venue at once:
 * `/api/v1/me/coach-time-off`.
 *
 * Only for an `ACTIVE` link (409 `COACH_LINK_STATE`). 400 `VALIDATION_ERROR`
 * with `details.field: "hours"` and a `details.reason` of `BAD_DAY`,
 * `BAD_TIME`, `ENDS_BEFORE_IT_STARTS`, `OVERLAP` or `TOO_MANY`. Answers with
 * the whole list of links.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = (await req.json().catch(() => null)) as { hours?: unknown } | null;
  await saveTeachingHours(ctx.userId, id, body?.hours);
  return ok(toMyCoachLinks(await myCoachLinks(ctx.userId)));
}

export const PUT = defineV1Route(handler);
