import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { listReviewCases, QUEUE_PAGE_SIZE } from '@/app-layer/usecases/moderation-queue';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toModerationCaseItem } from '@/app/api/v1/_lib/dto';
import { page } from '@/app/api/v1/_lib/envelope';
import { readPlatformCursor, UnknownPlatformCursorError } from '@/app/api/v1/_lib/platform-cursor';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/moderation/cases — the open review moderation cases,
 * across every club, oldest first.
 *
 * ═══ WHY THE PLATFORM TREE, AND NOT A CLUB'S ADMIN ═══
 *
 * A club moderating reviews of itself is the one arrangement moderation must
 * not have: its incentive is to hold back every bad review. So the queue is
 * worked by a person with authority over no club in particular, and that is
 * what a platform grant is. It is shaped exactly like `/platform/tenants`, the
 * reference: `platformRoute: true`, a 401 before the database, a stated reason
 * checked before authority, `asPlatformAdmin` and never `asSuperuser`, a cursor.
 *
 * ═══ REVIEW_MODERATE, FOR READING TOO ═══
 *
 * The queue shows review text across every club, which is more than
 * TENANT_READ's "operational data" and is only useful to someone who can act on
 * it. So the capability that permits the decision also permits the reading, and
 * a grant for incident response does not quietly include the queue.
 *
 * Every page read writes a PLATFORM_MODERATION_QUEUE_READ row with the reason
 * the moderator gave. `subjectTenantId` is null: a page of the queue is about
 * several clubs, like the tenant list.
 */
async function handler(req: NextRequest) {
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

  const sp = req.nextUrl.searchParams;
  // No default — see readPlatformReason. Checked before the binding, so a bad
  // request is a 400 and an unauthorised one a 403, and neither reveals the other.
  const stated = readPlatformReason(sp);
  if (!stated.ok) return stated.response;

  const paged = readPlatformCursor(sp);
  if (!paged.ok) return paged.response;
  const cursor = paged.cursor;

  const { items, nextCursor } = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.REVIEW_MODERATE,
      action: 'PLATFORM_MODERATION_QUEUE_READ',
      reason: stated.reason,
      entity: 'ModerationCase',
      subjectTenantId: null,
    },
    async (db) => {
      let after: { id: string; createdAt: Date } | undefined;
      if (cursor) {
        // Inside the transaction, so a case removed between a pre-flight check
        // and the read cannot slip through as a silent empty page.
        const anchor = await db.moderationCase.findUnique({
          where: { id: cursor },
          select: { id: true, createdAt: true },
        });
        if (!anchor) throw new UnknownPlatformCursorError();
        after = anchor;
      }
      return listReviewCases(db, { limit: QUEUE_PAGE_SIZE, after });
    },
  );

  return page(items.map(toModerationCaseItem), nextCursor);
}

export const GET = defineV1Route(handler);
