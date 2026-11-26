import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { notifyReviewRefused } from '@/app-layer/usecases/review-notifications';
import { resolveCase } from '@/app-layer/usecases/reviews';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toModerationResolution } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { checkPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { ValidationError } from '@/lib/errors/types';
import { isRefusalReason, REFUSAL_REASONS } from '@/lib/moderation/refusal';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/platform/moderation/cases/{id}/resolve — a moderator decides.
 *
 * APPROVE publishes the review; REJECT hides it. Either way the case closes
 * with the moderator's note, and the venue's rating is recomputed in the same
 * transaction — a decision that did not move the score would have no effect
 * on the thing reviews exist to produce.
 *
 * ═══ THE FIRST CROSS-CLUB WRITE ═══
 *
 * Every other platform route reads. REVIEW_MODERATE is the one write
 * `STEP_UP_PLATFORM_WRITES` admits, by the owner's decision on #228, and the
 * reasoning — narrow reach, nothing deleted, every decision audited with the
 * moderator's own words — is written there, where the refusal of every other
 * write lives.
 *
 * Since #262 the binding also demands a second-factor step-up on the calling
 * session from the last 15 minutes (403 STEP_UP_REQUIRED, or
 * MFA_ENROLMENT_REQUIRED for a moderator with no authenticator), checked inside
 * the transaction before the audit row. Nothing in this file had to change for
 * that: `asPlatformAdmin` carries the session id, and the capability decides.
 *
 * ═══ THE NOTE IS THE AUDIT REASON ═══
 *
 * The same text becomes the case's `resolutionNote` — the moderator's answer
 * to "why?", kept with the case — and the platform audit row's `reason`. One sentence,
 * written once, in both places that need it; the 12-character minimum is the
 * platform's own, so "ok" does not decide anything.
 *
 * ═══ subjectTenantId IS NULL, AND WHY THAT LOSES NOTHING ═══
 *
 * The binding writes the audit row BEFORE the work, and until the work reads
 * the case nobody knows which club it belongs to. The row names the case
 * (`entity`, `entityId`), and cases are never deleted and carry their club, so
 * the club is one join away rather than guessed.
 *
 * A refusal — already resolved, or no such case — rolls the audit row back
 * with everything else: the log records decisions that were made.
 *
 * ═══ THE AUTHOR IS TOLD WHY (#714) ═══
 *
 * The note is the moderator's own words, for the audit trail; the author is
 * not shown it. What the author gets, when a review is refused or removed, is
 * the statement of reasons the Digital Services Act (Art. 17) asks for: the
 * RULE (`rule`, one of the `RefusalReason` codes; left out, the one the case's
 * category maps to, else `other`), that a person decided, and how to object.
 * It goes as a bell row and an email, after the decision committed.
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
    rule?: unknown;
  } | null;

  const decision = body?.decision;
  if (decision !== 'APPROVE' && decision !== 'REJECT') {
    throw new ValidationError('`decision` must be "APPROVE" or "REJECT"', { field: 'decision' });
  }

  const rule = body?.rule;
  if (rule !== undefined && rule !== null && !isRefusalReason(rule)) {
    throw new ValidationError(`\`rule\` must be one of ${REFUSAL_REASONS.join(', ')}`, {
      field: 'rule',
    });
  }

  const stated = checkPlatformReason(typeof body?.note === 'string' ? body.note : '', '`note`');
  if (!stated.ok) return stated.response;

  const moderatorUserId = ctx.userId;
  const approve = (decision as Decision) === 'APPROVE';

  const resolution = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.REVIEW_MODERATE,
      action: approve ? 'PLATFORM_REVIEW_APPROVED' : 'PLATFORM_REVIEW_REJECTED',
      reason: stated.reason,
      entity: 'ModerationCase',
      entityId: id,
      subjectTenantId: null,
      detailsJson: { decision },
    },
    (db) =>
      resolveCase(db, {
        caseId: id,
        moderatorUserId,
        approve,
        note: stated.reason,
        rule: isRefusalReason(rule) ? rule : undefined,
      }),
  );

  // After the commit, never before: a notice about a decision that rolled
  // back would describe nothing. Never throws.
  if (resolution.refused) await notifyReviewRefused(resolution.refused);

  return ok(toModerationResolution(resolution));
}

export const POST = defineV1Route(handler);
