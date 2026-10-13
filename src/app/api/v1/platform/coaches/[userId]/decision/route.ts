import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import {
  COACH_DECISIONS,
  decideCoachApplication,
  notifyCoachDecision,
} from '@/app-layer/usecases/coach-approval';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { toCoachDecision } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { checkPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/platform/coaches/{userId}/decision
 * body: { decision: "APPROVE" | "DECLINE" | "REMOVE", note }
 *
 * The platform owner's decision on a coach's profile (#545; owner decisions
 * 13 and 17).
 *
 *   APPROVE   a waiting profile is approved
 *   DECLINE   a waiting profile is declined; the coach reads `note`, corrects
 *             the profile and may send it again
 *   REMOVE    an approved coach is stopped: the profile is declined with
 *             `note`, THE CERTIFICATE IS DELETED, and the coach's links to
 *             venues end. Refused with 409 `COACH_HAS_UPCOMING_LESSONS`
 *             (`details.lessons`) while a lesson is still to be taught.
 *
 * `note` is required, 12 to 500 characters. It is the audit row's reason for
 * all three. For DECLINE and REMOVE it is also WHAT THE COACH IS SHOWN AND
 * EMAILED, so write it to them. An approval's note stays in the audit trail.
 *
 * `COACH_APPROVE` and a fresh second-factor step-up. Audited as
 * `PLATFORM_COACH_APPLICATION_DECIDE` with the decision. A decision that does
 * not fit the profile's state (approving one that is not waiting, removing
 * one that is not approved, or one another admin just decided) is 409
 * `COACH_APPLICATION_STATE` with `details.status`. The coach is told in the
 * bell and by email.
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

  const body = (await req.json().catch(() => null)) as {
    decision?: unknown;
    note?: unknown;
  } | null;
  const decision = COACH_DECISIONS.find((d) => d === body?.decision);
  if (!decision) {
    throw new ValidationError('`decision` must be "APPROVE", "DECLINE" or "REMOVE"', {
      field: 'decision',
    });
  }
  const stated = checkPlatformReason(typeof body?.note === 'string' ? body.note : '', '`note`');
  if (!stated.ok) return stated.response;

  const actorUserId = ctx.userId;
  const result = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.COACH_APPROVE,
      action: 'PLATFORM_COACH_APPLICATION_DECIDE',
      reason: stated.reason,
      entity: 'CoachProfile',
      entityId: userId,
      subjectTenantId: null,
      detailsJson: { decision },
    },
    (db) => decideCoachApplication(db, { userId, decision, note: stated.reason, actorUserId }),
  );
  // After the commit: the bell and the email are about a decision that stands.
  await notifyCoachDecision(result);
  return ok(toCoachDecision(result));
}

export const POST = defineV1Route(handler);
