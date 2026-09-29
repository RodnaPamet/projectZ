import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Server-side tenant creation for E2E. Talks to Prisma DIRECTLY, not
 * through the API — a fixture that provisions via the app under test
 * cannot distinguish "the app is broken" from "the fixture is broken".
 *
 * Every row is stamped with `tenantTestRun` so teardown is unambiguous
 * even when a spec crashes mid-way and leaves rows behind.
 */

let client: PrismaClient | undefined;

function prisma(): PrismaClient {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is unset — E2E needs .env.test loaded.');
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  return client;
}

export interface IsolatedTenant {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  email: string;
  password: string;
  testRun: string;
}

export const E2E_PASSWORD = 'TestPass123!';

export async function createIsolatedTenant(): Promise<IsolatedTenant> {
  const db = prisma();
  const testRun = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const email = `${slug}@playerz.test`;

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    const tenant = await tx.venueOrg.create({
      data: {
        name: `E2E ${slug}`,
        slug,
        contactEmail: `${slug}@playerz.test`,
        city: 'Sofia',
        tenantTestRun: testRun,
      },
    });
    // A CLUB account (#263): the database refuses an ACTIVE OWNER membership
    // on any other kind of account.
    const user = await tx.user.create({
      data: { email, name: 'E2E Owner', accountKind: 'CLUB' },
    });
    await tx.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
    });

    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      userId: user.id,
      email,
      password: E2E_PASSWORD,
      testRun,
    };
  });
}

export async function destroyTenant(tenantId: string): Promise<void> {
  const db = prisma();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    // Memberships cascade from the org.
    await tx.venueOrg.deleteMany({ where: { id: tenantId } });
  });
}

/** Sweep anything a crashed spec left behind. */
export async function destroyTestRun(testRun: string): Promise<void> {
  const db = prisma();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venueOrg.deleteMany({ where: { tenantTestRun: testRun } });
  });
}

export async function disconnect(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
