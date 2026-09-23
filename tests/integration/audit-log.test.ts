import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

import { prismaTestClient, seedTenant, withTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The audit log, against a real database.
 *
 * Both guarantees this table exists for are DATABASE guarantees — an
 * append-only trigger and an RLS policy. Neither can be tested without
 * Postgres, and asserting them in a unit test against a mock would be
 * asserting that the mock behaves like the mock.
 */
describe('audit_entry', () => {
  const db = prismaTestClient();

  let tenant: SeededTenant;
  let other: SeededTenant;

  beforeEach(async () => {
    tenant = await seedTenant({});
    other = await seedTenant({});
  });

  const write = (t: SeededTenant, overrides: Record<string, unknown> = {}) =>
    withTenant(t.tenantId, (tx) =>
      appendAuditEntry(tx, {
        tenantId: t.tenantId,
        actorUserId: t.userId,
        entity: 'TenantMembership',
        entityId: 'membership-1',
        action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
        details: 'role PLAYER → MANAGER',
        detailsJson: { before: { role: 'PLAYER' }, after: { role: 'MANAGER' } },
        ...overrides,
      }),
    );

  it('writes a row a human and a machine can both read', async () => {
    await write(tenant);

    const rows = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'MEMBER_ROLE_CHANGED',
      entity: 'TenantMembership',
      actorType: 'USER',
      details: 'role PLAYER → MANAGER',
    });
    expect(rows[0]!.detailsJson).toEqual({
      before: { role: 'PLAYER' },
      after: { role: 'MANAGER' },
    });
  });

  it('REFUSES an UPDATE — the database, not a convention', async () => {
    // A history that application code is merely trusted not to rewrite is a
    // history on the honour system. One UPDATE to tidy up a support ticket and
    // it is a lie nobody can detect, because it is the only copy.
    await write(tenant);

    const row = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { tenantId: tenant.tenantId } }),
    );

    await expect(
      asAppSuperuser(db, (tx) =>
        tx.auditEntry.update({ where: { id: row.id }, data: { details: 'nothing happened' } }),
      ),
    ).rejects.toThrow(/APPEND-ONLY/);
  });

  it('REFUSES a DELETE', async () => {
    // A trigger guarding only UPDATE is strictly worse than useless: an
    // altered row is at least still a row, and a deleted one leaves no trace
    // that anything was ever there.
    await write(tenant);

    const row = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { tenantId: tenant.tenantId } }),
    );

    await expect(
      asAppSuperuser(db, (tx) => tx.auditEntry.delete({ where: { id: row.id } })),
    ).rejects.toThrow(/APPEND-ONLY/);
  });

  it('refuses even a superuser — BYPASSRLS does not bypass a trigger', async () => {
    // Worth pinning separately. RLS is bypassed by app_superuser, so if the
    // append-only guarantee had been written as a policy it would evaporate on
    // exactly the connection that admin scripts use.
    await write(tenant);

    await expect(
      asAppSuperuser(db, (tx) =>
        tx.auditEntry.updateMany({
          where: { tenantId: tenant.tenantId },
          data: { action: 'NOTHING_HAPPENED' },
        }),
      ),
    ).rejects.toThrow(/APPEND-ONLY/);
  });

  it('is invisible across tenants', async () => {
    await write(tenant);
    await write(other);

    const seen = await withTenant(tenant.tenantId, (tx) => tx.auditEntry.findMany({}));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.tenantId).toBe(tenant.tenantId);
  });

  it('cannot be stamped with another tenant — the WITH CHECK is symmetric', async () => {
    // Without a WITH CHECK, a connection bound to A could INSERT a row
    // labelled B: an audit trail you can plant entries in for someone else.
    await expect(
      withTenant(tenant.tenantId, (tx) =>
        appendAuditEntry(tx, {
          tenantId: other.tenantId,
          entity: 'TenantMembership',
          entityId: 'x',
          action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
        }),
      ),
    ).rejects.toThrow();
  });

  it('rolls back with the change it records', async () => {
    // THE reason appendAuditEntry takes the caller's handle. An audit write on
    // its own connection would commit here, leaving the log asserting a role
    // change that never happened — worse than no log, because it is believed.
    await expect(
      withTenant(tenant.tenantId, async (tx) => {
        await appendAuditEntry(tx, {
          tenantId: tenant.tenantId,
          entity: 'TenantMembership',
          entityId: 'membership-1',
          action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
        });
        throw new Error('the change failed after the audit write');
      }),
    ).rejects.toThrow('the change failed');

    const rows = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(rows).toHaveLength(0);
  });

  it('records SYSTEM as an actor distinct from a person', async () => {
    // A directory-driven sync changes someone's access with nobody deciding
    // it. Telling that apart from an administrator doing it by hand is most of
    // what the trail is for.
    await write(tenant, { actorUserId: null, actorType: 'SYSTEM' });

    const row = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { tenantId: tenant.tenantId } }),
    );

    expect(row.actorType).toBe('SYSTEM');
    expect(row.actorUserId).toBeNull();
  });

  it('stores NULL rather than the literal "unknown" outside a request', async () => {
    await write(tenant);

    const row = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirstOrThrow({ where: { tenantId: tenant.tenantId } }),
    );

    // A column full of 'unknown' reads like a value somebody chose.
    expect(row.requestId).toBeNull();
  });
});
