import { writeSync } from 'node:fs';

import { assertPasswordSignInNotDeployed } from '@/lib/auth/password-sign-in';
import { assertLeastPrivilegeConnection } from '@/lib/db/assert-least-privilege';

/**
 * Node-runtime startup checks.
 *
 * Separate from `instrumentation.ts` so the Prisma client — and `pg` beneath it
 * — is never pulled into the edge bundle. `register()` awaits this, so nothing
 * is served until it resolves, and a throw here means nothing is served at all:
 * measured on Next 16.3, `next start` keeps its port after a failed
 * instrumentation hook and answers every request, `/api/health` included, with
 * a 500. That is the intent for the database check: see
 * assert-least-privilege.ts for why refusing beats warning into a log nobody
 * reads.
 *
 * ═══ THE PASSWORD CHECK EXITS ═══
 *
 * A deployment carrying the test-only password flag (#361,
 * `@/lib/auth/password-sign-in`) must not start at all, and a server that
 * holds its port while answering 500 has, as far as `docker compose` is
 * concerned, started. So that check ends the process: the container stops
 * with the reason as its last log line, and the deploy fails where it is
 * looked at. It reads only the environment, so it runs first, before a
 * database connection is opened.
 *
 * The reason goes out through `writeSync` because `process.exit` does not wait
 * for buffered output, and a refusal with no reason is a second incident.
 */
try {
  assertPasswordSignInNotDeployed();
} catch (error) {
  writeSync(2, `\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
}

await assertLeastPrivilegeConnection();
