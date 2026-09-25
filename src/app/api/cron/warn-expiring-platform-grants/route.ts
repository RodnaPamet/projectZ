import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * Warn before a platform grant lapses.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * `platform_admin_grant.expiresAt` is NOT NULL with a 90-day CHECK, so "admin
 * for ever" is not expressible. That is the right default and it has one
 * concrete failure mode, named when the cap was chosen:
 *
 *   the on-call admin's grant lapses at 03:00 during an outage, the route
 *   403s with no warning, and they reach for something worse — a psql
 *   prompt, or a hand-edited row.
 *
 * Shipping the cap without a warning is choosing that outcome. So this runs
 * daily, and `docs/platform-admin-runbook.md` says what to do when it fires.
 *
 * ═══ IT WARNS, IT DOES NOT EXTEND ═══
 *
 * Deliberately read-only. An automatic renewal would defeat the cap: the point
 * of an expiry is that somebody decides again, with a fresh reason and a fresh
 * granter. A grant is immutable except for revocation, enforced by a trigger,
 * so this could not extend one even if it tried.
 *
 * ═══ THE SECRET IS THE WHOLE SECURITY BOUNDARY ═══
 *
 * Same as release-expired-bookings, and for the same verified reasons: the edge
 * guard allows any path with no tenant slug, `requiredPermission` has rules only
 * under `/api/(vN/)?t/`, and `route-permission-coverage` inspects only that
 * prefix. Three layers each decline to cover this path.
 *
 * A missing CRON_SECRET returns 503, never "unset means allow" — that inversion
 * is how an internal endpoint ends up open the day somebody forgets an env var.
 */
function authorised(req: NextRequest): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to check grant expiry', { component: 'cron' });
    return { ok: false, status: 503 };
  }

  const header =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  // Length first, because timingSafeEqual throws on a mismatch. That comparison
  // discloses the secret's LENGTH, which is a cost worth naming and accepting.
  if (a.length !== b.length) return { ok: false, status: 401 };
  if (!timingSafeEqual(a, b)) return { ok: false, status: 401 };

  return { ok: true };
}

/** How far ahead to warn. Long enough that a renewal is not itself a scramble. */
const WARN_WITHIN_DAYS = 7;

/**
 * Upper bound on rows scanned. One live grant per person by construction, so
 * this is orders of magnitude above reality; reaching it is a signal, not a
 * limit to tune.
 */
const GRANT_SCAN_CAP = 500;

export async function POST(req: NextRequest) {
  const auth = authorised(req);

  if (!auth.ok) {
    return NextResponse.json(
      {
        error: {
          code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
          message: auth.status === 503 ? 'Grant expiry check is not configured' : 'Unauthorized',
        },
      },
      { status: auth.status },
    );
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + WARN_WITHIN_DAYS * 24 * 60 * 60 * 1000);

  // `platform_admin_grant` denies app_user outright, so this needs the
  // superuser path. It is machine work with no human actor, which is why it is
  // `runAsSuperuser` and not `asPlatformAdmin`: there is no grant to audit it
  // against, and a cron job reading expiry dates is not a person reaching into
  // a club.
  const grants = await runAsSuperuser((db) =>
    db.platformAdminGrant.findMany({
      where: { revokedAt: null, expiresAt: { lte: horizon } },
      select: { id: true, userId: true, expiresAt: true, capabilities: true },
      orderBy: { expiresAt: 'asc' },
      // Bounded, because `query-shape` requires it and is right to: an
      // unbounded findMany is a query whose cost is set by data rather than by
      // code. Soonest-first, so if the cap were ever reached the rows dropped
      // are the least urgent.
      //
      // The cap is far above any plausible reality — a handful of people hold
      // platform authority, and the partial unique index allows one live grant
      // each. Hitting it would mean something is very wrong, which is why it
      // is reported rather than silently truncated.
      take: GRANT_SCAN_CAP,
    }),
  );

  const expiring = grants.filter((g) => g.expiresAt > now);
  const lapsed = grants.filter((g) => g.expiresAt <= now);

  for (const g of expiring) {
    const hours = Math.round((g.expiresAt.getTime() - now.getTime()) / 36e5);
    logger.warn('platform grant expiring', {
      component: 'cron',
      grantId: g.id,
      // The user ID, never the email: logging-hygiene forbids PII in log lines,
      // and an id is enough to look the person up.
      userId: g.userId,
      hoursRemaining: hours,
      capabilities: g.capabilities,
    });
  }

  for (const g of lapsed) {
    // Already expired and never revoked. The holder is locked out, and the
    // grant still occupies the one-live-grant slot — so a renewal will be
    // refused by the partial unique index until somebody revokes it. That is
    // the exact trap the runbook covers.
    logger.warn('platform grant has LAPSED and still occupies the live slot', {
      component: 'cron',
      grantId: g.id,
      userId: g.userId,
      expiredAt: g.expiresAt.toISOString(),
    });
  }

  if (grants.length === GRANT_SCAN_CAP) {
    // Reported, never silent. A truncated scan that looks identical to a
    // complete one is how "no grants are expiring" becomes a false statement.
    logger.error('grant expiry scan hit its cap; some grants were NOT checked', {
      component: 'cron',
      cap: GRANT_SCAN_CAP,
    });
  }

  return NextResponse.json({
    checkedAt: now.toISOString(),
    warnWithinDays: WARN_WITHIN_DAYS,
    expiringSoon: expiring.length,
    lapsed: lapsed.length,
    truncated: grants.length === GRANT_SCAN_CAP,
  });
}
