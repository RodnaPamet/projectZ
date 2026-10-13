import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { coachApplication } from '@/app-layer/usecases/coach-approval';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { toCoachApplication } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/coaches/{userId}?reason=…
 *
 * One coach's profile as the platform owner reads it before deciding (#545):
 * the name on the account, the text, the qualifications, the sports and
 * levels, what was uploaded as a certificate (its name, type, size and time,
 * not the file), the last decision's note, and how many lessons the coach
 * still has to teach (a removal is refused while there are any).
 *
 * `COACH_APPROVE` and a fresh step-up, as the list. `reason` is required;
 * the read is audited as `PLATFORM_COACH_APPLICATION_READ` with the coach's
 * id. 404 `COACH_APPLICATION_NOT_FOUND` for an account with no profile, or
 * with a draft: a draft was not sent to anybody.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const ctx = await contextFromRequest(req, { requestId: getRequestId(), platformRoute: true });
  if (!ctx.userId) {
    return NextResponse.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
          requestId: getRequestId(),
        },
      },
      { status: 401 },
    );
  }
  const stated = readPlatformReason(req.nextUrl.searchParams);
  if (!stated.ok) return stated.response;

  const application = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.COACH_APPROVE,
      action: 'PLATFORM_COACH_APPLICATION_READ',
      reason: stated.reason,
      entity: 'CoachProfile',
      entityId: userId,
      subjectTenantId: null,
    },
    (db) => coachApplication(db, userId),
  );
  return ok(toCoachApplication(application));
}

export const GET = defineV1Route(handler);
