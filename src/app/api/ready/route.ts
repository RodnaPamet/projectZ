import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db/prisma';
import { pushChannels } from '@/lib/push/channels';
import { redis } from '@/lib/redis';

/**
 * READINESS — "should traffic be sent to this pod?"
 *
 * ═══ THIS IS NOT LIVENESS, AND THE DIFFERENCE IS AN OUTAGE ═══
 *
 * Liveness (`/api/health`) answers "is this process alive?" and deliberately
 * touches NOTHING. Readiness answers "can this pod serve a request right now?"
 * and therefore checks its dependencies.
 *
 * Confusing the two is the classic way to turn a recoverable incident into a
 * total outage:
 *
 *   • Put a database check in LIVENESS, and a thirty-second Postgres blip makes
 *     Kubernetes kill EVERY pod at once — including the ones that were fine. The
 *     database comes back; there is now nothing left to serve from. A degraded
 *     dependency has become a hard outage, and the restart storm makes the
 *     database's recovery slower.
 *
 *   • Leave the dependency check out of READINESS, and a pod that cannot reach
 *     Postgres keeps receiving traffic and 500ing at users, because as far as the
 *     load balancer knows it is perfectly healthy.
 *
 * So: liveness never touches the database. Readiness always does. A ratchet
 * (tests/guardrails/health-checks.test.ts) enforces both directions.
 */

/** Never cached, never statically rendered — the answer changes by the second. */
export const dynamic = 'force-dynamic';

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function timed(name: string, fn: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();

  try {
    // A dependency that has not answered in two seconds is a dependency that is
    // down, as far as a request is concerned. Waiting longer just means the
    // readiness probe itself times out, and Kubernetes cannot tell "slow" from
    // "hung".
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 2_000)),
    ]);

    return { name, ok: true, ms: Date.now() - started };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : 'unknown',
    };
  }
}

export async function GET() {
  const checks = await Promise.all([
    // SELECT 1, not a real query. A readiness probe runs every few seconds on
    // every pod; making it do real work turns the health check itself into load.
    timed('postgres', () => prisma.$queryRaw`SELECT 1`),
    timed('redis', () => redis().ping()),
  ]);

  const ready = checks.every((c) => c.ok);

  // Reported, and deliberately NOT part of `ready`. Push is an enhancement: a
  // missing optional credential must not take a pod out of rotation, or a
  // deploy gets blocked by something nobody considered load-bearing.
  //
  // It is here because both push paths disable themselves SILENTLY when their
  // credentials are absent, and nothing said so — APNs had never sent a
  // notification and no deploy could discover that (#166). "configured" means
  // the credentials are present, not that they work.
  const features = { push: pushChannels() };

  return NextResponse.json(
    { status: ready ? 'ready' : 'not_ready', checks, features },
    {
      // 503, so the load balancer actually takes the pod out of rotation. A 200
      // with `{"status": "not_ready"}` in the body is a health check that nothing
      // reads — every orchestrator looks at the STATUS CODE.
      status: ready ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
