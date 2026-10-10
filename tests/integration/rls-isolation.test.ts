import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser, asAppUser, expectRlsIsolated } from '../helpers/rls';

/**
 * Tenant isolation, proven at the database layer.
 *
 * These are the tests that let every repository downstream be written
 * without paranoia. If they pass for the wrong reason, every "tenant A
 * cannot see tenant B" claim in this codebase is worthless — so each one
 * asserts a positive control alongside the negative: the row really does
 * exist, and a superuser really can see it.
 */
describe('RLS isolation', () => {
  const prisma = prismaTestClient();

  it('1. tenant A sees only its own VenueOrg', async () => {
    const a = await seedTenant({ name: 'Sofia Padel Club' });
    await seedTenant({ name: 'Plovdiv Tennis Center' });

    const rows = await asAppUser(prisma, a.tenantId, (tx) => tx.venueOrg.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.tenantId);
  });

  it('2. tenant B sees only its own VenueOrg', async () => {
    const a = await seedTenant({ name: 'Sofia Padel Club' });
    const b = await seedTenant({ name: 'Plovdiv Tennis Center' });

    const rows = await asAppUser(prisma, b.tenantId, (tx) => tx.venueOrg.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(b.tenantId);
    expect(rows.map((r) => r.id)).not.toContain(a.tenantId);
  });

  it('3. an UNSCOPED session sees zero rows — RLS defaults to DENY', async () => {
    await seedTenant();
    await seedTenant();

    // current_setting('app.tenant_id', true) -> NULL when unset, and
    // `col = NULL` is NULL, not TRUE. So: nothing matches.
    await expectRlsIsolated(prisma, (tx) => tx.venueOrg.findMany());
    await expectRlsIsolated(prisma, (tx) => tx.tenantMembership.findMany());
  });

  it('4. INSERT carrying another tenant id is rejected by WITH CHECK', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const outsider = await asAppSuperuser(prisma, (tx) =>
      tx.user.create({ data: { email: `outsider-${Date.now()}@playerz.test` } }),
    );

    // Authenticated as A, but writing a row tagged B. The policy's WITH
    // CHECK clause must refuse it — USING alone would not.
    await expect(
      asAppUser(prisma, a.tenantId, (tx) =>
        tx.tenantMembership.create({
          data: { tenantId: b.tenantId, userId: outsider.id, role: 'PLAYER', status: 'ACTIVE' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('5. UPDATE moving a row from tenant A to tenant B is rejected', async () => {
    const a = await seedTenant();
    const b = await seedTenant();

    const membership = await asAppUser(prisma, a.tenantId, (tx) =>
      tx.tenantMembership.findFirstOrThrow(),
    );

    // Re-parenting a row into another tenant is the subtlest form of the
    // same attack: the row is legitimately yours until the moment it isn't.
    await expect(
      asAppUser(prisma, a.tenantId, (tx) =>
        tx.tenantMembership.update({
          where: { id: membership.id },
          data: { tenantId: b.tenantId },
        }),
      ),
    ).rejects.toThrow();

    // And it really did not move.
    const after = await asAppSuperuser(prisma, (tx) =>
      tx.tenantMembership.findUniqueOrThrow({ where: { id: membership.id } }),
    );
    expect(after.tenantId).toBe(a.tenantId);
  });

  it('6. app_superuser sees rows across BOTH tenants', async () => {
    await seedTenant();
    await seedTenant();

    const rows = await asAppSuperuser(prisma, (tx) => tx.venueOrg.findMany());

    // The positive control for tests 1–3: the rows exist. Without this,
    // "A sees only its own" would also hold on an empty table.
    expect(rows).toHaveLength(2);
  });

  it('7. UserSession: a NULL-tenant session is neither readable nor re-parentable by app_user', async () => {
    const a = await seedTenant();
    const b = await seedTenant();

    // A pre-tenant session is minted at SIGN-IN — before any tenant is
    // selected, so there is no tenant context to bind. That path runs
    // outside app_user, which is why WITH CHECK can safely forbid app_user
    // from writing NULL-tenant rows at all.
    const session = await asAppSuperuser(prisma, (tx) =>
      tx.userSession.create({
        data: {
          userId: a.userId,
          tenantId: null,
          tokenHash: `tok-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    );
    expect(session.tenantId).toBeNull();

    // A tenant-bound app_user may NOT mint one itself — WITH CHECK omits
    // the NULL branch on purpose.
    await expect(
      asAppUser(prisma, a.tenantId, (tx) =>
        tx.userSession.create({
          data: {
            userId: a.userId,
            tenantId: null,
            tokenHash: `tok-forbidden-${Date.now()}`,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);

    // Nor read one. Until P58 (#488) USING kept a NULL branch, so every
    // app_user session, even one bound to another club, read every pre-tenant
    // session and could delete it. Every session read is on the superuser
    // path (sign-in, checkSession, refresh, sign-out), so nothing needs it.
    const readBack = await asAppUser(prisma, a.tenantId, (tx) =>
      tx.userSession.findMany({ where: { id: session.id } }),
    );
    expect(readBack).toHaveLength(0);

    // And never move it into a tenant: the row is invisible to UPDATE, and
    // WITH CHECK refuses any tenant that is not the bound one.
    await expect(
      asAppUser(prisma, a.tenantId, (tx) =>
        tx.userSession.update({ where: { id: session.id }, data: { tenantId: b.tenantId } }),
      ),
    ).rejects.toThrow();
  });
});
