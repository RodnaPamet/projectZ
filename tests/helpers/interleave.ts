import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * A client that lets a test run something BETWEEN two statements of one query.
 *
 * ═══ WHY (#419) ═══
 *
 * Prisma 7 loads a relation with a SECOND select: `userSession.findUnique({
 * select: { user: ... } })` is `SELECT … FROM user_session` and then `SELECT …
 * FROM app_user WHERE id = $1`. Inside a READ COMMITTED transaction another
 * connection can commit between the two. If it deleted the user, the first
 * select already returned the session and the second finds nothing, and Prisma
 * returns `user: null` for a relation the schema calls required.
 *
 * That window is microseconds wide, which is why it showed once in an E2E log
 * (a fixture deleting its player while a page was still rendering) and never
 * in a test. This makes it deterministic: `afterSelectFrom` arms a hook that
 * runs, on a different connection, the moment a statement reading that table
 * returns, before Prisma sends the next one.
 *
 * Only statements inside an interactive transaction are wrapped, which is
 * every `runAsSuperuser` and `runInTenantContext` call.
 */

let client: PrismaClient | undefined;
let armed: { table: string; hook: () => Promise<void> } | null = null;

type Query = { sql: string };
type Queryable = { queryRaw: (q: Query) => Promise<unknown> };
type Adapter = Queryable & { startTransaction: (...a: unknown[]) => Promise<Queryable> };

export function interleavingClient(): PrismaClient {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url || !/playerz_test/.test(url)) {
    throw new Error('interleavingClient: DATABASE_URL must name a playerz_test database.');
  }

  const base = new PrismaPg({ connectionString: url });
  const factory = {
    provider: base.provider,
    adapterName: base.adapterName,
    async connect() {
      const adapter = (await base.connect()) as unknown as Adapter;
      const start = adapter.startTransaction.bind(adapter);
      adapter.startTransaction = async (...args: unknown[]) => {
        const tx = await start(...args);
        const query = tx.queryRaw.bind(tx);
        tx.queryRaw = async (q: Query) => {
          const result = await query(q);
          if (armed && q.sql.includes(`FROM "public"."${armed.table}"`)) {
            const { hook } = armed;
            armed = null;
            await hook();
          }
          return result;
        };
        return tx;
      };
      return adapter;
    },
  };

  client = new PrismaClient({ adapter: factory as unknown as PrismaPg });
  return client;
}

/** Run `hook` once, right after the next statement in a transaction that reads `table`. */
export function afterSelectFrom(table: string, hook: () => Promise<void>): void {
  armed = { table, hook };
}

/** Whether the armed hook has fired. A test asserting a race must also assert it raced. */
export function hookPending(): boolean {
  return armed !== null;
}

export async function disconnectInterleavingClient(): Promise<void> {
  armed = null;
  await client?.$disconnect();
  client = undefined;
}
