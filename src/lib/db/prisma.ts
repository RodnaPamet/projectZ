import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * A warm pool (#601). node-postgres closes a connection after 10 s idle by
 * default. At the pilot's traffic most pages arrive after a quiet spell, so
 * the first queries of a page waited for new connections: about 30 ms each to
 * open against a local Postgres, and more on Prisma's first use of each. A club
 * page's redirect took ~110 ms instead of ~20 in the perf runs, because its
 * session check and membership read each opened one.
 *
 * `min` keeps four open whatever the traffic: enough for a page's parallel
 * reads, and the pool never closes below it. Above it, an idle connection
 * closes after a minute. Each app's pool still tops out at node-postgres's 10,
 * and production's Postgres allows 100. `allowExitOnIdle` lets a process whose
 * only open handles are idle connections (a test run, a script) exit as before;
 * the server stays up because it listens.
 */
const POOL = { min: 4, idleTimeoutMillis: 60_000, allowExitOnIdle: true } as const;

/**
 * The Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter — `datasources` and `datasourceUrl`
 * are both rejected by the constructor.
 *
 * In dev, Next's HMR re-evaluates modules on every edit; without the
 * global cache each reload would open a fresh pool and exhaust Postgres's
 * connection limit within a few minutes.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  // Fall back to '' rather than throwing: Next's build step imports every
  // route module to collect metadata, often with DATABASE_URL unset. A
  // throw here fails the whole build at import time; an empty string lets
  // the module load and surfaces the real error on the first query.
  const url = process.env.DATABASE_URL ?? '';
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, ...POOL }) });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
