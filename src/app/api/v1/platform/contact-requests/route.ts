import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { CONTACT_PAGE_SIZE, listContactRequests } from '@/app-layer/usecases/contact-requests';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rfc3339 } from '@/app/api/v1/_lib/dto';
import { page } from '@/app/api/v1/_lib/envelope';
import { readPlatformCursor, UnknownPlatformCursorError } from '@/app/api/v1/_lib/platform-cursor';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/contact-requests — the landing page's club enquiries
 * (#369), newest first.
 *
 * Shaped exactly like `/platform/tenants`, the reference: `platformRoute: true`,
 * a 401 before the database, a stated reason checked before authority,
 * `asPlatformAdmin` and never `asSuperuser`, a cursor.
 *
 * ═══ CONTACT_READ ═══
 *
 * The rows are names, phone numbers and emails strangers sent to the operator.
 * They belong to no club, so TENANT_READ says nothing about them, and they are
 * not user records either. Reading them is its own capability, granted by
 * name, and every page read writes a PLATFORM_CONTACT_REQUEST_LIST row with the
 * reason given. `subjectTenantId` is null: an enquiry is about no club yet.
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
      capability: PlatformCapability.CONTACT_READ,
      action: 'PLATFORM_CONTACT_REQUEST_LIST',
      reason: stated.reason,
      entity: 'ContactRequest',
      subjectTenantId: null,
    },
    async (db) => {
      let after: { id: string; createdAt: Date } | undefined;
      if (cursor) {
        // Inside the transaction, so a row removed between a pre-flight check
        // and the read cannot slip through as a silent empty page.
        const anchor = await db.contactRequest.findUnique({
          where: { id: cursor },
          select: { id: true, createdAt: true },
        });
        if (!anchor) throw new UnknownPlatformCursorError();
        after = anchor;
      }
      return listContactRequests(db, { limit: CONTACT_PAGE_SIZE, after });
    },
  );

  return page(
    // `rfc3339`, not the Date: see the tenants route.
    items.map((r) => ({ ...r, createdAt: rfc3339(r.createdAt) })),
    nextCursor,
  );
}

export const GET = defineV1Route(handler);
