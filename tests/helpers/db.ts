import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * The database test harness.
 *
 * Everything here talks to the Postgres in `docker-compose.test.yml`
 * (port 55432), never the dev stack — `resetDatabase()` TRUNCATEs, and
 * pointing that at a dev database would be unforgivable. `.env.test` is
 * the only source of DATABASE_URL, and `prismaTestClient()` refuses to
 * run against anything that doesn't look like the test database.
 */

let client: PrismaClient | undefined;

export function prismaTestClient(): PrismaClient {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is unset. Integration tests need .env.test loaded.');
  }

  // Guard rail, not paranoia: a truncating harness pointed at the dev
  // database destroys real data. Fail loudly instead.
  if (!/playerz_test/.test(url)) {
    throw new Error(
      `Refusing to run the test harness against a non-test database.\n` +
        `  DATABASE_URL must name playerz_test; got: ${url.replace(/:[^:@]*@/, ':***@')}`,
    );
  }

  // Prisma 7 requires a driver adapter — both `datasources: { db: { url } }`
  // and the flat `datasourceUrl` are rejected by the constructor.
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  return client;
}

/**
 * TRUNCATE every user table, CASCADE, RESTART IDENTITY.
 *
 * The table list is introspected from Prisma's runtime data model rather
 * than hard-coded — a new model added in P04/P05 is truncated
 * automatically, so the harness cannot silently start leaking rows
 * between tests when the schema grows.
 */
export async function resetDatabase(prisma: PrismaClient = prismaTestClient()): Promise<void> {
  const tables = tableNames(prisma);
  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t}"`).join(', ');
  // app_superuser: TRUNCATE must cross every tenant boundary.
  await prisma.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Physical table names for every model in the schema. */
export function tableNames(prisma: PrismaClient = prismaTestClient()): string[] {
  // `_runtimeDataModel` is internal, but it is the only way to enumerate
  // models without re-parsing the schema. If Prisma moves it, the
  // meta-ratchet in tests/guardrails/test-infra-integrity.test.ts fails
  // loudly rather than this silently truncating nothing.
  const runtime = (prisma as unknown as { _runtimeDataModel?: { models: Record<string, unknown> } })
    ._runtimeDataModel;

  if (!runtime?.models) {
    throw new Error(
      'Could not read prisma._runtimeDataModel — the introspection contract changed. ' +
        'resetDatabase() would silently truncate nothing.',
    );
  }

  return Object.entries(runtime.models).map(([name, model]) => {
    const dbName = (model as { dbName?: string | null }).dbName;
    return dbName ?? name;
  });
}

export interface SeededTenant {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  ownerEmail: string;
  ownerPassword: string;
}

export const TEST_PASSWORD = 'TestPass123!';

/** A VenueOrg + an OWNER User + an ACTIVE membership joining them. */
export async function seedTenant(
  opts: { name?: string; ownerEmail?: string; testRun?: string } = {},
  prisma: PrismaClient = prismaTestClient(),
): Promise<SeededTenant> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const name = opts.name ?? `Test Venue ${suffix}`;
  const slug = slugify(`${name}-${suffix}`);
  const ownerEmail = opts.ownerEmail ?? `owner-${suffix}@playerz.test`;

  // Seeding crosses the tenant boundary by definition (the tenant does not
  // exist yet, so there is no app.tenant_id to set).
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    const tenant = await tx.venueOrg.create({
      data: {
        name,
        slug,
        contactEmail: `contact-${suffix}@playerz.test`,
        city: 'Sofia',
        tenantTestRun: opts.testRun ?? null,
      },
    });

    // A CLUB account (#263): an owner owns one club and plays nowhere, and the
    // database refuses an ACTIVE OWNER membership on any other kind.
    const user = await tx.user.create({
      data: { email: ownerEmail, name: 'Test Owner', passwordHash: null, accountKind: 'CLUB' },
    });

    await tx.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
    });

    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      userId: user.id,
      ownerEmail,
      ownerPassword: TEST_PASSWORD,
    };
  });
}

/**
 * Run `fn` inside a transaction bound to a tenant — the app_user-role
 * wrapper the RLS tests use. This is what the request path does.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: PrismaClient) => Promise<T>,
  prisma: PrismaClient = prismaTestClient(),
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
    return fn(tx as unknown as PrismaClient);
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
