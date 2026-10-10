import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { resolveChatCase } from '@/app-layer/usecases/moderation-messages';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { checkPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/platform/moderation/message-cases/{id}/resolve — a moderator
 * decides a reported message or conversation (#375).
 *
 * The sibling of `cases/{id}/resolve`, which decides reviews; a separate route
 * so the audit row names what was decided (PLATFORM_MESSAGE_APPROVED /
 * _REJECTED) before the work reads the case, as the binding requires. It
 * refuses a review case with CASE_NOT_FOUND, as that route refuses nothing.
 *
 *   APPROVE  keep it; the case closes
 *   REJECT   a message: removed, a tombstone in its place; a conversation:
 *            closed for both sides, for good
 *
 * Same capability (REVIEW_MODERATE), same step-up, same note: the note is the
 * case's `resolutionNote` and the audit row's reason, 12 characters at least.
 */
type Decision = 'APPROVE' | 'REJECT';

async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, {
    requestId: getRequestId(),
    platformRoute: true,
  });

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

  const decision = body?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') {
    throw new ValidationError('`decision` must be "APPROVE" or "REJECT"', { field: 'decision' });
  }

  const stated = checkPlatformReason(typeof body?.note === 'string' ? body.note : '', '`note`');
  if (!stated.ok) return stated.response;

  const moderatorUserId = ctx.userId;
  const approve = (decision as Decision) === 'APPROVE';

  const resolution = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.REVIEW_MODERATE,
      action: approve ? 'PLATFORM_MESSAGE_APPROVED' : 'PLATFORM_MESSAGE_REJECTED',
      reason: stated.reason,
      entity: 'ModerationCase',
      entityId: id,
      subjectTenantId: null,
      detailsJson: { decision },
    },
    (db) => resolveChatCase(db, { caseId: id, moderatorUserId, approve, note: stated.reason }),
  );

  return ok(resolution);
}

export const POST = defineV1Route(handler);
