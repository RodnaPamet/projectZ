import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rfc3339 } from '@/app/api/v1/_lib/dto';
import { page } from '@/app/api/v1/_lib/envelope';
import { readPlatformCursor, UnknownPlatformCursorError } from '@/app/api/v1/_lib/platform-cursor';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/audit — what platform admins have done.
 *
 * ═══ THE FIRST CALLER OF asPlatformAdmin ═══
 *
 * The binding, the grant table, the triggers and the CLI all shipped before any
 * route existed. That was deliberate staging — the security lives in the
 * database — but it left `asPlatformAdmin` with zero call sites, which is the
 * shape this repo keeps producing and then forgetting. This route is what makes
 * the feature reachable.
 *
 * ═══ READING THE AUDIT LOG IS ITSELF AUDITED ═══
 *
 * Not a flourish. "Who has been looking at who looked at what" is exactly the
 * question an investigation asks, and an audit reader that exempts itself
 * cannot answer it. `runAsPlatformAdmin` writes the row before this handler's
 * callback runs, so the read cannot happen without leaving one.
 *
 * It needs AUDIT_READ specifically, not TENANT_READ. Someone granted read
 * access to a club's bookings has no business reading the record of platform
 * access — those are different questions and a grant should be able to carry
 * one without the other.
 *
 * ═══ THE REASON IS REQUIRED, WITH NO DEFAULT ═══
 *
 * The first draft of these routes defaulted it, which satisfied the
 * 12-character minimum and said nothing — see `readPlatformReason` for why that
 * is worse than refusing. The check runs before the grant is consulted, so a
 * 400 cannot be used to learn whether a grant exists.
 *
 * ═══ WHY THIS PAGES RATHER THAN CAPPING ═══
 *
 * A capped list was the obvious first shape and it is a trap here. Every
 * platform request writes one row — including each page of this read — so the
 * table passes 50 within days of the feature being used, and from then on the
 * answer to "show me what happened" would be the most recent fiftieth of it,
 * with nothing in the response saying so.
 *
 * A silently truncated audit log is worse than no audit log: the investigator
 * believes they have looked. So the page carries `nextCursor`, and exhausting
 * the log is the client's job rather than a thing it cannot do.
 *
 * Newest first, which keeps the page boundaries steady for the common case: a
 * row written after the walk began carries a later `createdAt`, sorts above the
 * cursor, and cannot displace anything below it.
 *
 * It is NOT a snapshot, and the difference matters if somebody is reconciling.
 * `createdAt` defaults to `now()`, which in Postgres is TRANSACTION START. A
 * platform action whose transaction opened before the walk reached that
 * timestamp, and committed after, has a `createdAt` the walk has already passed
 * — so that one pass misses it. The row is in the table; it is not in this
 * walk's results. A second walk finds it. For a genuine point-in-time answer,
 * read the table directly with the query in the runbook.
 *
 * ═══ WHY THERE IS NO tenantId FILTER YET ═══
 *
 * `platform_audit_entry.subjectTenantId` is nullable by design: a cross-club
 * sweep is about no single club. Filtering by tenant would therefore hide
 * precisely the broadest actions, which are the ones most worth seeing. When a
 * per-club view is wanted it should be additive and say what it excludes.
 */
const PAGE_SIZE = 50;

async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, {
    requestId: getRequestId(),
    // Without this the grant is never resolved, `appPermissions` stays empty,
    // and asPlatformAdmin refuses every request — fail-closed, but silently.
    // A guardrail asserts every route under this tree sets it.
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
  // Deliberately no default — see readPlatformReason: a reason the server
  // invented is worse than none. Checked before the BINDING, so a malformed
  // request is a 400 and an unauthorised one a 403, and neither reveals the
  // other. (The grant was already resolved by contextFromRequest above; that
  // read costs a query but tells the caller nothing.)
  const stated = readPlatformReason(sp);
  if (!stated.ok) return stated.response;

  // A cursor with no business being one is a 400 here rather than a 500 from
  // Postgres; a cursor naming no row is a 400 from inside the binding below.
  // See platform-cursor.ts for why an unknown cursor cannot be allowed to
  // return an innocent-looking empty page.
  const paged = readPlatformCursor(sp);
  if (!paged.ok) return paged.response;
  const cursor = paged.cursor;

  const rows = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.AUDIT_READ,
      action: 'PLATFORM_AUDIT_READ',
      reason: stated.reason,
      entity: 'PlatformAuditEntry',
    },
    async (db) => {
      if (cursor) {
        // Inside the transaction, so a row deleted between a pre-flight check
        // and the read cannot slip through as a silent empty page.
        const anchor = await db.platformAuditEntry.findUnique({
          where: { id: cursor },
          select: { id: true },
        });
        if (!anchor) throw new UnknownPlatformCursorError();
      }

      return db.platformAuditEntry.findMany({
        select: {
          id: true,
          actorUserId: true,
          capability: true,
          action: true,
          subjectTenantId: true,
          entity: true,
          entityId: true,
          reason: true,
          createdAt: true,
        },
        // `id` is not decoration: `createdAt` alone is not unique — the audit
        // row this very request writes shares a timestamp with anything else
        // committing in the same tick — and a non-unique sort makes the cursor
        // skip or repeat rows.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // One more than asked, so "is there another page" costs no second
        // count(*). The extra row is trimmed before it is returned.
        take: PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    },
  );

  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  // See the tenants route: a raw Date serialises with `.000Z`, which the
  // generated Swift client refuses to decode.
  return page(
    items.map((e) => ({ ...e, createdAt: rfc3339(e.createdAt) })),
    hasMore ? (items.at(-1)?.id ?? null) : null,
  );
}

export const GET = defineV1Route(handler);
