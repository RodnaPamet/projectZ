import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Count the SQL statements a callback sends to Postgres.
 *
 * For proving a load is a CONSTANT number of queries rather than one per row:
 * the N+1 a timing never shows on seed data (8 courts, 8 short counts) and
 * always shows on a big club. Assert the count for 1 row and for N and require
 * them equal.
 *
 * ═══ WHY A SECOND CLIENT, LOGGING EVERY QUERY ═══
 *
 * Prisma emits a `query` event per statement only when the client is BUILT
 * with `log: [{ emit: 'event', level: 'query' }]`; the shared test client is
 * not, and turning it on there would make every integration test pay for the
 * listener. So this builds its own client, against the same guarded test
 * database, and the code under test is handed it — `runInTenantContext` takes
 * a client as its third argument for exactly this.
 *
 * Events are what Postgres actually received: the transaction's BEGIN/COMMIT
 * and the RLS binding statements count too. That is deliberate — they are
 * round trips — and harmless for a 1-vs-N comparison, where they cancel out.
 */

let client: PrismaClient | undefined;
let recording: string[] | null = null;

export function queryCountingClient(): PrismaClient {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url || !/playerz_test/.test(url)) {
    throw new Error('queryCountingClient: DATABASE_URL must name a playerz_test database.');
  }

  const logging = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: [{ emit: 'event', level: 'query' }],
  });
  logging.$on('query', (e) => {
    recording?.push(e.query);
  });
  client = logging as unknown as PrismaClient;
  return client;
}

/**
 * Run `fn` with the counting client and return its result and the statements
 * it sent, in order. Not re-entrant: one recording at a time, which is all a
 * `--runInBand` integration suite ever has.
 */
export async function countQueries<T>(
  fn: (db: PrismaClient) => Promise<T>,
): Promise<{ result: T; queries: string[] }> {
  if (recording) throw new Error('countQueries is not re-entrant.');
  const db = queryCountingClient();
  recording = [];
  try {
    const result = await fn(db);
    return { result, queries: recording };
  } finally {
    recording = null;
  }
}

export async function disconnectQueryCountingClient(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
