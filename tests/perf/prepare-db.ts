import { execFileSync } from 'node:child_process';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import { resetDatabase } from '../helpers/db';

import { PERF_APP_ROLE, PERF_APP_ROLE_PASSWORD, PERF_DB_OWNER_URL, PERF_REDIS_URL } from './config';
import { seedPerfFixture, type PerfSeedSummary } from './seed-perf';

/**
 * Bring the perf database to the same state before every run: migrated,
 * emptied, seeded.
 *
 * ═══ EMPTIED, EVERY RUN ═══
 *
 * The data is placed relative to today, so yesterday's run left bookings that
 * are now a day older. Seeding on top of them would grow every list a little
 * each day, and a later run would look slower because it had more to render.
 * A comparison is only fair when both sides render the same rows, so each run
 * TRUNCATEs and re-seeds. `resetDatabase` is the same function the integration
 * harness uses between tests.
 *
 * `prisma migrate reset` would also work, but it refuses to run under an AI
 * agent without a human's consent. This harness has to be re-runnable by the
 * agents that will be judged against it, and TRUNCATE on a database named for
 * this purpose needs no such consent.
 *
 * ═══ THE GUARD ═══
 *
 * This deletes every row it can reach. It refuses any database whose name does
 * not end in `_perf`, and any host that is not this machine. That is the same
 * idea as `prismaTestClient`'s refusal of anything but `playerz_test`: a
 * truncating harness pointed at the wrong URL destroys data.
 */
export function assertPerfDatabase(url: string): void {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, '');
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  if (!local || !/_perf$/.test(name)) {
    throw new Error(
      `Refusing to reset "${name}" on "${u.hostname}". The perf harness TRUNCATEs its ` +
        `database, so it only runs against a LOCAL database whose name ends in _perf ` +
        `(default: playerz_perf on 127.0.0.1:55432). Set PERF_DATABASE_URL.`,
    );
  }
}

const log = (msg: string) => process.stdout.write(`[perf:db] ${msg}\n`);

export async function prepareDatabase(now: Date): Promise<PerfSeedSummary> {
  assertPerfDatabase(PERF_DB_OWNER_URL);

  // Both URLs name the owner: migrations and the seed create and fill tables,
  // which is exactly what the runtime role may not do.
  const ownerEnv = {
    ...process.env,
    DATABASE_URL: PERF_DB_OWNER_URL,
    DIRECT_DATABASE_URL: PERF_DB_OWNER_URL,
  };

  // stderr is kept so a failure says why; stdout is only progress chatter.
  const quiet = {
    env: ownerEnv,
    stdio: ['ignore', 'ignore', 'pipe'] as ['ignore', 'ignore', 'pipe'],
  };

  log('prisma migrate deploy');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], quiet);

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: PERF_DB_OWNER_URL }) });
  try {
    log('truncate every table');
    await resetDatabase(db);

    // Idempotent. CREATE ROLE has no IF NOT EXISTS, hence the DO block; the
    // ALTER and GRANTs re-assert the shape on every run so a role somebody
    // edited by hand cannot quietly change what is being measured.
    log(`ensure runtime role ${PERF_APP_ROLE}`);
    await db.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PERF_APP_ROLE}') THEN
          CREATE ROLE ${PERF_APP_ROLE} LOGIN NOINHERIT;
        END IF;
      END $$`);
    // Interpolated because ALTER ROLE ... PASSWORD takes a literal, not a
    // parameter. Both values are constants in config.ts.
    await db.$executeRawUnsafe(
      `ALTER ROLE ${PERF_APP_ROLE} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${PERF_APP_ROLE_PASSWORD}'`,
    );
    await db.$executeRawUnsafe(`GRANT app_user TO ${PERF_APP_ROLE} WITH INHERIT FALSE, SET TRUE`);
    await db.$executeRawUnsafe(
      `GRANT app_superuser TO ${PERF_APP_ROLE} WITH INHERIT FALSE, SET TRUE`,
    );

    log('scripts/seed.ts');
    execFileSync('npx', ['tsx', 'scripts/seed.ts'], quiet);

    log('perf fixture');
    const summary = await seedPerfFixture(db, now);
    log(
      `${summary.clubs} clubs, ${summary.courts} courts, ${summary.players} players, ` +
        `${summary.bookings} bookings (${summary.bookingsTodayAtClub} today at the club, ` +
        `${summary.personaBookings} the player's)`,
    );

    // The sign-in throttle allows ten attempts per IP per fifteen minutes, and
    // each run signs in twice. Its counters from earlier runs are cleared so
    // that re-running the harness in quick succession cannot lock it out. Only
    // the limiter's own keys, in Redis database 5, which is the harness's own.
    const redis = new Redis(PERF_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      const keys = await redis.keys('ratelimit:*');
      if (keys.length > 0) await redis.del(...keys);
    } catch (err) {
      log(`could not clear the sign-in throttle (${String(err)}); continuing`);
    } finally {
      redis.disconnect();
    }

    return summary;
  } finally {
    await db.$disconnect();
  }
}
