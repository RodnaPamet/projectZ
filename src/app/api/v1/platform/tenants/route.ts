import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rfc3339 } from '@/app/api/v1/_lib/dto';
import {
  inSeekOrder,
  type SeekCursor,
  tenantPageIds,
} from '@/app-layer/repositories/platform-paging';
import { page } from '@/app/api/v1/_lib/envelope';
import { readPlatformCursor, UnknownPlatformCursorError } from '@/app/api/v1/_lib/platform-cursor';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/tenants — every club, across tenant boundaries.
 *
 * ═══ THIS IS THE REFERENCE, SO IT IS DELIBERATELY BORING ═══
 *
 * Every later platform read should look like this one. It is a list of clubs
 * because that is the smallest genuinely cross-tenant question: a tenant-bound
 * request can only ever see its own, so returning more than one row here proves
 * the binding does what it claims.
 *
 * What it demonstrates, in order:
 *
 *   platformRoute: true      so the grant is resolved for this request
 *   a userId check           a 401 before THIS route touches the database
 *   asPlatformAdmin          never asSuperuser — the pin from #173 enforces this
 *   a named capability       TENANT_READ, refused if the grant lacks it
 *   a stated reason          required, 12+ chars, into an append-only row, and
 *                            checked BEFORE authority so it cannot probe for a grant
 *   a cursor                 because a capped list with no page two is a dead end
 *
 * ═══ WHY NOT asSuperuser, WHICH WOULD ALSO WORK ═══
 *
 * It would, and that is the danger. Both reach every club; only one leaves a
 * record of who looked and why. `asSuperuser` remains correct for machine work
 * with no human actor — the public venue index spans every club too — and is
 * wrong the moment a PERSON reaches into a club that is not theirs.
 *
 * Two guardrails keep that real rather than aspirational:
 * `superuser-call-sites` fails the build if a file reaches for the untraced
 * version, and `platform-route-discipline` fails it if any verb under this tree
 * reaches anything other than the audited one.
 *
 * ═══ WHAT IT DOES NOT RETURN ═══
 *
 * Bookings, members, payments. A club list answers "which clubs exist" and
 * nothing about the people in them. Reading a specific club's operational data
 * should be its own route, with its own audited action naming that club in
 * `subjectTenantId` — which this one deliberately leaves null, because a list
 * of every club is about no single one.
 */
const PAGE_SIZE = 100;

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
      capability: PlatformCapability.TENANT_READ,
      action: 'PLATFORM_TENANT_LIST',
      reason: stated.reason,
      entity: 'VenueOrg',
      // Null on purpose: this is about every club, not one. See the docblock.
      subjectTenantId: null,
    },
    async (db) => {
      // Seek for the ids, typed client for the rows — see the audit route and
      // platform-paging.ts. Prisma's `cursor` scans from the top of the index
      // rather than seeking, which measured 18.4 ms against 7.6 ms on a deep
      // page of the audit log.
      let after: SeekCursor | undefined;
      if (cursor) {
        // Inside the transaction, so a row deleted between a pre-flight check
        // and the read cannot slip through as a silent empty page.
        const anchor = await db.venueOrg.findUnique({
          where: { id: cursor },
          select: { id: true, createdAt: true },
        });
        if (!anchor) throw new UnknownPlatformCursorError();
        after = anchor;
      }

      const ids = await tenantPageIds(db, { limit: PAGE_SIZE, after });
      if (ids.length === 0) return [];

      const rows = await db.venueOrg.findMany({
        where: { id: { in: ids } },
        select: { id: true, slug: true, name: true, city: true, country: true, createdAt: true },
        // Bounded by `ids` already — it cannot exceed PAGE_SIZE + 1 — but
        // stated, because `query-shape` D2 takes no view on whether an `in`
        // happens to be short today, and it is right not to.
        take: PAGE_SIZE + 1,
      });

      return inSeekOrder(rows, ids);
    },
  );

  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  return page(
    // `rfc3339`, not the Date. NextResponse.json would call toISOString(),
    // which emits `.000Z` — and Swift's default `.iso8601` decoding strategy
    // REJECTS fractional seconds, failing at the decoder so the error names the
    // whole response rather than the field. dto.ts says every timestamp
    // crossing this boundary goes through it; that sentence has to stay true.
    items.map((t) => ({ ...t, createdAt: rfc3339(t.createdAt) })),
    hasMore ? (items.at(-1)?.id ?? null) : null,
  );
}

export const GET = defineV1Route(handler);
