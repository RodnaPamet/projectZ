import { prismaTestClient, resetDatabase } from './db';
import { closeRedis } from '@/lib/redis';

/**
 * ═══ 30s, BECAUSE 5s IS A BUDGET FOR A TEST THAT TOUCHES NOTHING ═══
 *
 * Jest's default is 5000ms and it governs HOOKS as well as tests. These suites
 * talk to a real Postgres, Meilisearch and Redis, and every one of them starts
 * by TRUNCATEing 55 tables in the beforeEach below.
 *
 * Measured locally, `resetDatabase` takes 240-431ms — about 11x headroom, right
 * up until it does not. On CI it once exceeded 5000ms, which failed the HOOK,
 * which failed the test that was about to run, and reported it as:
 *
 *     ● the credit ledger › a balance is the sum of its entries, and starts at zero
 *       thrown: "Exceeded timeout of 5000 ms for a hook."
 *
 * The symptom named the wrong subsystem. Anyone chasing it reads payments code
 * and finds nothing wrong, because nothing is.
 *
 * ═══ WHY HERE AND NOT IN jest.config.mjs ═══
 *
 * Jest 30 IGNORES `testTimeout` in a project config — verified: with
 * `testTimeout: 30_000` on the integration project, a 7s test still failed at
 * 5000ms. It works only at the ROOT of the config, which would relax every
 * project including the unit suites, where a 5s budget is the right discipline.
 *
 * `setupFilesAfterEnv` for this project is the one place that is both honoured
 * and correctly scoped: integration only, tests and hooks.
 *
 * This does not hide a systematic slowdown — that would show as suites taking
 * tens of seconds each, which is visible in the run output. It absorbs a
 * stall: a lock wait, a cold connection, a noisy runner.
 */
jest.setTimeout(30_000);

// Every integration test starts from an empty database. `--runInBand`
// (jest maxWorkers: 1 on the integration project) makes that safe: a
// parallel worker would truncate another's rows mid-test.
const prisma = prismaTestClient();

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();

  // And Redis. The rate limiter is Redis-backed as of #125, so ANY suite that
  // exercises a rate-limited route now opens a connection — not just the two
  // files that use Redis deliberately and close it themselves.
  //
  // An open socket keeps the event loop alive, so jest runs every test, prints
  // nothing, and never exits. Measured: a full integration run sat at three
  // live processes for over half an hour with zero output, which reads exactly
  // like a deadlocked test rather than a finished one.
  //
  // Closing an already-closed client is a no-op, so this is safe for the
  // suites that also close it themselves.
  await closeRedis();
});
