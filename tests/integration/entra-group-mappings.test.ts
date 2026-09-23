import {
  createGroupMapping,
  deleteGroupMapping,
  DuplicateGroupMappingError,
  listGroupMappings,
  MappingNotFoundError,
  RoleNotMappableError,
  updateGroupMapping,
} from '@/app-layer/usecases/entra-group-mappings';

import { prismaTestClient, seedTenant, withTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Entra group mappings, against a real database.
 *
 * These rows decide who can administer a club, so the guarantees worth testing
 * are the ones the database holds: tenant isolation, the uniqueness that stops
 * two rows racing for the same group, the CHECK that refuses OWNER even to a
 * caller that never passed through Zod, and the audit row sharing the
 * transaction with the change it records.
 */
describe('Entra group mappings', () => {
  const db = prismaTestClient();

  const GROUP_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const GROUP_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  let tenant: SeededTenant;
  let other: SeededTenant;

  beforeEach(async () => {
    tenant = await seedTenant({});
    other = await seedTenant({});
  });

  const create = (t: SeededTenant, input: Record<string, unknown>) =>
    withTenant(t.tenantId, (tx) =>
      createGroupMapping(tx, t.tenantId, t.userId, {
        aadGroupId: GROUP_A,
        role: 'MANAGER',
        priority: 0,
        ...input,
      } as never),
    );

  const auditRows = (t: SeededTenant) =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: t.tenantId }, orderBy: { createdAt: 'asc' } }),
    );

  it('creates a mapping and audits it in the same breath', async () => {
    const mapping = await create(tenant, { role: 'MANAGER', priority: 50 });

    expect(mapping.role).toBe('MANAGER');

    const audit = await auditRows(tenant);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'SSO_GROUP_MAPPING_CREATED',
      entity: 'TenantEntraGroupMapping',
      entityId: mapping.id,
      actorUserId: tenant.userId,
    });
  });

  it('records what a mapping changed FROM, not just to', async () => {
    // "What is it now?" is answerable by looking at the row. The question an
    // investigation actually asks is what it used to be.
    const mapping = await create(tenant, { role: 'STAFF' });

    await withTenant(tenant.tenantId, (tx) =>
      updateGroupMapping(tx, tenant.tenantId, tenant.userId, mapping.id, { role: 'MANAGER' }),
    );

    const audit = await auditRows(tenant);
    const updated = audit.find((a) => a.action === 'SSO_GROUP_MAPPING_UPDATED');

    expect(updated!.detailsJson).toMatchObject({
      before: { role: 'STAFF' },
      after: { role: 'MANAGER' },
    });
  });

  it('a deleted mapping survives only as its audit row, so that row carries everything', async () => {
    const mapping = await create(tenant, { role: 'COACH', priority: 70, aadGroupName: 'Coaches' });

    await withTenant(tenant.tenantId, (tx) =>
      deleteGroupMapping(tx, tenant.tenantId, tenant.userId, mapping.id),
    );

    const remaining = await withTenant(tenant.tenantId, (tx) =>
      listGroupMappings(tx, tenant.tenantId),
    );
    expect(remaining).toHaveLength(0);

    const audit = await auditRows(tenant);
    const deleted = audit.find((a) => a.action === 'SSO_GROUP_MAPPING_DELETED');

    expect(deleted!.detailsJson).toMatchObject({
      before: { aadGroupId: GROUP_A, aadGroupName: 'Coaches', role: 'COACH', priority: 70 },
    });
  });

  it('the audit row and the mapping commit together or not at all', async () => {
    // appendAuditEntry shares the caller's handle precisely so this holds. A
    // separate connection would leave the log asserting a mapping that does
    // not exist.
    await expect(
      withTenant(tenant.tenantId, async (tx) => {
        await createGroupMapping(tx, tenant.tenantId, tenant.userId, {
          aadGroupId: GROUP_A,
          role: 'MANAGER',
          priority: 0,
        });
        throw new Error('something later failed');
      }),
    ).rejects.toThrow('something later failed');

    expect(await auditRows(tenant)).toHaveLength(0);
    expect(
      await withTenant(tenant.tenantId, (tx) => listGroupMappings(tx, tenant.tenantId)),
    ).toHaveLength(0);
  });

  it('refuses a second mapping for the same group — the index arbitrates', async () => {
    // Not a read-then-write: two admins adding the same group at once would
    // both see "not present" and both insert, and the winner of the role
    // assignment would then depend on scan order.
    await create(tenant, {});

    await expect(create(tenant, { role: 'STAFF' })).rejects.toThrow(DuplicateGroupMappingError);
  });

  it('refuses OWNER at the use case, for callers that never saw the Zod schema', async () => {
    await expect(create(tenant, { role: 'OWNER' })).rejects.toThrow(RoleNotMappableError);
  });

  it('refuses OWNER at the DATABASE, for callers that never saw the use case', async () => {
    // The fourth enforcement point, and the only one that also binds a psql
    // session or a seed script. The other three are each one edit from gone.
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenant_entra_group_mapping" ("id","tenantId","aadGroupId","role","priority","updatedAt")
           VALUES ('probe-1', $1, $2, 'OWNER', 0, NOW())`,
          tenant.tenantId,
          GROUP_B,
        ),
      ),
      // Named exactly. A loose /check constraint/ would also pass if the insert
      // were rejected for some unrelated reason — RLS, a renamed column — and
      // the test would then be asserting nothing about OWNER at all.
    ).rejects.toThrow(/tenant_entra_group_mapping_role_not_owner/);
  });

  it('refuses a priority outside the band at the database too', async () => {
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "tenant_entra_group_mapping" ("id","tenantId","aadGroupId","role","priority","updatedAt")
           VALUES ('probe-2', $1, $2, 'STAFF', 9999, NOW())`,
          tenant.tenantId,
          GROUP_B,
        ),
      ),
    ).rejects.toThrow(/tenant_entra_group_mapping_priority_bounded/);
  });

  it('is invisible across clubs', async () => {
    // These rows describe who can administer a club. One club reading
    // another's is reconnaissance, not a leak of cosmetics.
    await create(tenant, {});
    await create(other, { role: 'STAFF' });

    const seen = await withTenant(tenant.tenantId, (tx) => listGroupMappings(tx, tenant.tenantId));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.tenantId).toBe(tenant.tenantId);
  });

  it('will not update or delete another club’s mapping', async () => {
    const theirs = await create(other, {});

    await expect(
      withTenant(tenant.tenantId, (tx) =>
        updateGroupMapping(tx, tenant.tenantId, tenant.userId, theirs.id, { role: 'STAFF' }),
      ),
    ).rejects.toThrow(MappingNotFoundError);

    await expect(
      withTenant(tenant.tenantId, (tx) =>
        deleteGroupMapping(tx, tenant.tenantId, tenant.userId, theirs.id),
      ),
    ).rejects.toThrow(MappingNotFoundError);
  });

  it('lists highest priority first', async () => {
    await create(tenant, { aadGroupId: GROUP_A, role: 'PLAYER', priority: 10 });
    await create(tenant, { aadGroupId: GROUP_B, role: 'MANAGER', priority: 90 });

    const rows = await withTenant(tenant.tenantId, (tx) => listGroupMappings(tx, tenant.tenantId));

    expect(rows.map((r) => r.role)).toEqual(['MANAGER', 'PLAYER']);
  });
});
