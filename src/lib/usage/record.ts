import { Prisma } from '@prisma/client';
import { headers } from 'next/headers';
import { after } from 'next/server';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { isBot, usageDay, type UsageEventName } from './events';

/**
 * Counting a usage event (#371): one daily counter, incremented after the
 * response has gone.
 *
 * ═══ FAIL-OPEN, AND NEVER ON THE CRITICAL PATH ═══
 *
 * `countUsage` returns at once. The write is scheduled with Next's `after`,
 * which runs it once the response (or the page's stream) has finished, so it
 * adds no time to a page, no round trip to a navigation, and nothing a person
 * waits for. Any failure — the database down, the table missing — is caught
 * and logged as a warning; it never reaches the page or the route that asked.
 *
 * ═══ NOTHING ABOUT THE PERSON ═══
 *
 * The caller passes the user agent, which is checked against the crawler list
 * here and then dropped: it is not stored, logged or passed on. What is written
 * is `(day in Sofia, event, venue, club, count)` and nothing else.
 *
 * ═══ ONE STATEMENT ═══
 *
 * `INSERT … ON CONFLICT DO UPDATE SET count = count + 1`, rather than one row
 * per hit, so the table grows by events × venues per day, not by traffic. For a
 * venue event the club is read from the venue in the same statement, and only
 * for a venue that is publicly listed — a beacon naming an unknown or hidden
 * venue inserts nothing. No Redis buffer: at the pilot's traffic one indexed
 * upsert per event, after the response, is cheaper than the machinery to batch
 * it, and a buffer would lose counts on every deploy.
 *
 * ═══ WHY BYPASSRLS ═══
 *
 * `usage_daily` denies app_user outright (P49), and the events come from
 * public pages with no tenant to bind. Pinned in superuser-call-sites.
 */

export interface UsageTarget {
  /** The venue the event is about; omitted for the `/venues` index. */
  venueId?: string | null;
}

/**
 * Writes one count, now. Resolves whether or not it succeeded: errors are
 * logged and swallowed. Exported for the tests; product code calls
 * `countUsage`.
 */
export async function recordUsage(
  event: UsageEventName,
  target: UsageTarget,
  now: Date = new Date(),
): Promise<void> {
  const day = usageDay(now);
  try {
    await runAsSuperuser((db) =>
      target.venueId
        ? db.$executeRaw`
            INSERT INTO usage_daily ("day", "event", "venueId", "clubId", "count")
            SELECT ${day}::date, ${event}::"UsageEvent", v."id", v."tenantId", 1
              FROM venue v
              JOIN venue_org o ON o."id" = v."tenantId"
             WHERE v."id" = ${target.venueId}
               AND v."status" = 'ACTIVE'
               AND o."status" = 'ACTIVE'
            ON CONFLICT ("day", "event", "venueId")
            DO UPDATE SET "count" = usage_daily."count" + 1`
        : db.$executeRaw`
            INSERT INTO usage_daily ("day", "event", "venueId", "clubId", "count")
            VALUES (${day}::date, ${event}::"UsageEvent", '', NULL, 1)
            ON CONFLICT ("day", "event", "venueId")
            DO UPDATE SET "count" = usage_daily."count" + 1`,
    );
  } catch (error) {
    logger.warn('usage count not recorded', {
      component: 'usage',
      event,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Prisma.PrismaClientKnownRequestError ? { code: error.code } : {}),
    });
  }
}

/** Writes started outside a request scope (scripts, tests), so a test can wait for them. */
const detached = new Set<Promise<void>>();

/**
 * Count `event` after the response, unless the caller is a crawler.
 *
 * Synchronous and never throws. Inside a request (a page, a route handler)
 * the write goes to `after`. Outside one — a test calling a route handler
 * directly — `after` throws, and the write runs detached instead, still
 * without being awaited.
 */
export function countUsage(
  event: UsageEventName,
  target: UsageTarget,
  request: { userAgent: string | null | undefined },
): void {
  try {
    if (isBot(request.userAgent)) return;
    const now = new Date();
    const write = () => recordUsage(event, target, now);
    try {
      after(write);
    } catch {
      const p = write().finally(() => detached.delete(p));
      detached.add(p);
    }
  } catch (error) {
    logger.warn('usage count not scheduled', {
      component: 'usage',
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `countUsage` for a page (a server component). Reads the request's headers
 * during render, which `after` cannot do from a page, and skips a router
 * PREFETCH: a link prefetched is not a page seen. (The venue cards' `auto`
 * prefetch stops at loading.tsx and never runs the page, so this is the guard
 * for a `full` prefetch somebody adds later.) Never throws.
 */
export async function countPageUsage(event: UsageEventName, target: UsageTarget): Promise<void> {
  try {
    const h = await headers();
    if (h.get('next-router-prefetch')) return;
    countUsage(event, target, { userAgent: h.get('user-agent') });
  } catch (error) {
    logger.warn('usage count not scheduled', {
      component: 'usage',
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Resolves once every detached write has finished. For tests. */
export async function settleUsageWrites(): Promise<void> {
  while (detached.size > 0) await Promise.all([...detached]);
}
