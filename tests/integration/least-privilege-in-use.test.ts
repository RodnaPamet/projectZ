import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';

/**
 * THE FIRST THING IN THIS REPO THAT ACTUALLY CONNECTS AS `playerz_app`.
 *
 * `least-privileged-role.test.ts` asserts the role's SHAPE in eight tests — not
 * a superuser, no BYPASSRLS, no direct table grants, both memberships
 * non-inheriting. All true, all verified, and none of it proves the application
 * can run as that role, because nothing ever did.
 *
 * P24 created `playerz_app` and deliberately did not switch `DATABASE_URL` to
 * it. The result is the pattern this codebase keeps producing: a correct,
 * well-tested mechanism with no call site. `appPermissions`,
 * `PLATFORM_ADMIN_API_KEY` and `src/app-layer/execute.ts` were all the same
 * shape, and all three looked finished.
 *
 * ═══ WHAT THIS IS WORTH ═══
 *
 * Today `DATABASE_URL` connects as the owner — `rolsuper=true`,
 * `rolbypassrls=true`, measured. So tenant isolation holds only inside a
 * binding, and a query that forgets one silently returns EVERY club's rows
 * rather than failing. The only thing standing between those two outcomes is a
 * CI text scan (`route-db-binding`) which accepts `runAsSuperuser` as a valid
 * answer and does not bound who calls it.
 *
 * Under `playerz_app` that same query raises `permission denied for table …`.
 * These tests measure that difference directly, so "adopting P24 would work"
 * stops being an argument and becomes a fact with a date on it.
 */

const TEST_ROLE_PASSWORD = 'p24-integration-probe'; // pragma: allowlist secret

/** The test DB URL, rewritten to authenticate as playerz_app. */
function appRoleUrl(): string {
  const owner = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  const u = new URL(owner);
  u.username = 'playerz_app';
  u.password = TEST_ROLE_PASSWORD;
  return u.toString();
}

describe('the application can run as playerz_app (P24 in use, not just in shape)', () => {
  const owner = prismaTestClient();
  let app: PrismaClient;

  beforeAll(async () => {
    // The role ships with LOGIN and NO PASSWORD — verified against the cluster,
    // and a real blocker P24's own comments do not mention: it cannot
    // authenticate as created. A password must never live in a migration, so
    // production sets it from a secret store and this test sets a throwaway.
    // NOT inside asAppSuperuser. `ALTER ROLE` needs cluster-superuser or
    // CREATEROLE rights, and `app_superuser` is neither — it holds BYPASSRLS and
    // nothing else, so binding to it fails with "permission denied to alter
    // role" (measured). The raw owner connection (`playerz`, rolsuper=true) can
    // do it — and the fact that the app's own connection role CAN alter roles is
    // itself the problem P24 exists to solve.
    //
    // Interpolated rather than bound: ALTER ROLE ... PASSWORD takes a literal,
    // not a parameter. The value is a constant in this file.
    await owner.$executeRawUnsafe(`ALTER ROLE playerz_app PASSWORD '${TEST_ROLE_PASSWORD}'`);

    app = new PrismaClient({ adapter: new PrismaPg({ connectionString: appRoleUrl() }) });
  });

  afterAll(async () => {
    await app?.$disconnect();
    // Leave the role without a password again, so nothing outside this file can
    // authenticate as it by accident.
    await owner.$executeRawUnsafe(`ALTER ROLE playerz_app PASSWORD NULL`).catch(() => undefined);
  });

  it('can connect at all', async () => {
    // The positive control, and the thing the missing password blocks. Without
    // it every denial below could be a failed connection rather than a refused
    // privilege.
    const rows = await app.$queryRawUnsafe<{ who: string }[]>(`SELECT current_user AS who`);
    expect(rows[0]!.who).toBe('playerz_app');
  });

  it('is REFUSED an unbound table query — the entire point of P24', async () => {
    // This is the difference between the two worlds. As the owner today, this
    // same statement succeeds and returns every tenant's rows.
    await expect(app.$queryRawUnsafe(`SELECT count(*) FROM booking`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('is refused an unbound WRITE too', async () => {
    // Reads leaking is bad; writes landing in the wrong tenant is worse, and
    // `USING`/`WITH CHECK` asymmetry has bitten this schema before (P23).
    await expect(app.$executeRawUnsafe(`DELETE FROM booking WHERE id = 'nope'`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('CAN query once it binds to app_user, with RLS applied', async () => {
    // Every binding in rls-middleware.ts does exactly this pair of statements.
    // If this failed, P24 would be unadoptable rather than merely unadopted.
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.tenant_id', $1, true)`,
        'cnonexistent00000000000',
      );
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM booking`);
    });

    // Zero rows, not an error: RLS is applied and fails closed for a tenant
    // that does not exist. That is the correct shape, and it is what the owner
    // connection CANNOT demonstrate, because BYPASSRLS skips the policy.
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('CAN bind to app_superuser, which auth.ts and the cron sweeper need', async () => {
    // `auth.ts` has seven runAsSuperuser call sites and the booking sweeper has
    // two. If the SET were refused, sign-in itself would break under P24.
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      return tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM app_user`);
    });

    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(0);
  });

  it('CAN run the readiness probe unbound', async () => {
    // `src/app/api/ready/route.ts:70` issues `SELECT 1` on the singleton with no
    // binding. It is the one unbound query in the app, and it must keep working
    // — a liveness probe that needs a tenant is not a liveness probe.
    await expect(app.$queryRawUnsafe(`SELECT 1`)).resolves.toBeDefined();
  });

  it('cannot TRUNCATE, which is why the test harness keeps the owner URL', async () => {
    // `resetDatabase()` truncates every table between tests. It must therefore
    // stay on the owner connection: pointing the harness at playerz_app would
    // break every integration test, and the tempting "fix" is to grant
    // playerz_app more privilege, which undoes P24.
    await expect(app.$executeRawUnsafe(`TRUNCATE booking`)).rejects.toThrow(/permission denied/i);
  });

  it('does not silently hold its memberships without SET ROLE', async () => {
    // The subtle one, and the reason both grants are WITH INHERIT FALSE.
    // PostgreSQL 16 records the inherit option PER GRANT in
    // pg_auth_members.inherit_option, not on the role — so someone re-running
    // `GRANT app_user TO playerz_app` while the role happens to be INHERIT
    // re-records it as inheriting, and every unbound query starts working.
    //
    // Asserting the BEHAVIOUR here, not the catalogue: the existing shape test
    // reads inherit_option, and this proves what that setting actually buys.
    await expect(app.$queryRawUnsafe(`SELECT count(*) FROM venue`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});
