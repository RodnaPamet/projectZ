import type { EntraGroupClaims } from '@/lib/auth/entra-group-claims';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Entra group sync, against a real database.
 *
 * This is the first code in the application that writes
 * `TenantMembership.role` at all, so every guarantee here is new: OWNER
 * immunity, the audit row, and the refusal to act on a group list we could not
 * establish.
 */
describe('syncEntraMembershipRole', () => {
  const db = prismaTestClient();

  /** The club's Entra directory. Group ids are only meaningful within it. */
  const DIRECTORY = '11111111-1111-4111-8111-111111111111';

  const GROUP_MANAGERS = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const GROUP_COACHES = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  let tenant: SeededTenant;
  let playerId: string;

  const complete = (groups: string[]): EntraGroupClaims => ({
    groups,
    source: 'token',
    overage: false,
    complete: true,
    directoryTenantId: DIRECTORY,
  });

  const incomplete = (groups: string[] = []): EntraGroupClaims => ({
    groups,
    source: 'graph',
    overage: true,
    complete: false,
    directoryTenantId: DIRECTORY,
  });

  beforeEach(async () => {
    tenant = await seedTenant({});

    playerId = await asAppSuperuser(db, async (tx) => {
      const u = await tx.user.create({
        data: { email: `p-${Math.random().toString(36).slice(2)}@t.test`, name: 'P' },
      });
      await tx.tenantMembership.create({
        data: { tenantId: tenant.tenantId, userId: u.id, role: 'PLAYER', status: 'ACTIVE' },
      });
      return u.id;
    });
  });

  /** Entra federation must be switched ON for anything to happen at all now. */
  const enableEntra = (enforceGroupGate = false) =>
    asAppSuperuser(db, (tx) =>
      tx.tenantIdentityProvider.upsert({
        where: { tenantId_type: { tenantId: tenant.tenantId, type: 'ENTRA_ID' } },
        create: {
          tenantId: tenant.tenantId,
          type: 'ENTRA_ID',
          enabled: true,
          configJson: {
            aadTenantId: '11111111-1111-4111-8111-111111111111',
            clientId: '22222222-2222-4222-8222-222222222222',
            enforceGroupGate,
          },
        },
        update: { enabled: true, configJson: { enforceGroupGate } },
      }),
    );

  const mapGroup = (aadGroupId: string, role: string, priority = 0) =>
    asAppSuperuser(db, (tx) =>
      tx.tenantEntraGroupMapping.create({
        data: { tenantId: tenant.tenantId, aadGroupId, role: role as never, priority },
      }),
    );

  const gate = (enforceGroupGate: boolean) => enableEntra(enforceGroupGate);

  const sync = (userId: string, claims: EntraGroupClaims) =>
    asAppSuperuser(db, (tx) =>
      syncEntraMembershipRole(tx, { userId, tenantId: tenant.tenantId, claims }),
    );

  const roleOf = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.tenantMembership
        .findFirstOrThrow({ where: { userId, tenantId: tenant.tenantId } })
        .then((m) => m.role),
    );

  const audits = () =>
    asAppSuperuser(db, (tx) => tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }));

  it('promotes a member whose group is mapped, and audits it as SYSTEM', async () => {
    await enableEntra();
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    const r = await sync(playerId, complete([GROUP_MANAGERS]));

    expect(r).toMatchObject({ effectiveRole: 'MANAGER', changed: true, gateDenied: false });
    expect(await roleOf(playerId)).toBe('MANAGER');

    const [entry] = await audits();
    expect(entry).toMatchObject({
      action: 'MEMBER_ROLE_CHANGED',
      actorType: 'SYSTEM',
      actorUserId: null,
    });
    expect(entry!.detailsJson).toMatchObject({
      before: { role: 'PLAYER' },
      after: { role: 'MANAGER' },
      source: 'entra_group_sync',
    });
  });

  it('NEVER demotes the OWNER', async () => {
    await enableEntra();
    // A mapping is configuration and configuration can be wrong. The failure
    // mode of a wrong mapping must not be a club with no owner.
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    const r = await sync(tenant.userId, complete([GROUP_MANAGERS]));

    expect(r).toMatchObject({ effectiveRole: 'OWNER', changed: false });
    expect(await roleOf(tenant.userId)).toBe('OWNER');
  });

  it('never gate-denies the OWNER either', async () => {
    // An owner locked out of the club they own has nobody to let them back in.
    await mapGroup(GROUP_MANAGERS, 'MANAGER');
    await gate(true);

    const r = await sync(tenant.userId, complete([]));

    expect(r.gateDenied).toBe(false);
  });

  it('does not demote a member who matches nothing', async () => {
    await enableEntra();
    // Removing access is done by removing the membership or enabling the gate,
    // both deliberate. Silent demotion from an unrelated directory edit is how
    // a club loses its manager on tournament morning.
    await mapGroup(GROUP_MANAGERS, 'MANAGER');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.updateMany({
        where: { userId: playerId, tenantId: tenant.tenantId },
        data: { role: 'COACH' },
      }),
    );

    const r = await sync(playerId, complete(['unmapped-group']));

    expect(r.changed).toBe(false);
    expect(await roleOf(playerId)).toBe('COACH');
  });

  it('will not act on a group list it could not establish', async () => {
    // THE deviation from the ported implementation, which flattens an
    // unreachable Graph to []. Promoting on a guess is wrong; denying on one
    // turns a Microsoft outage into a club-wide lockout.
    await mapGroup(GROUP_MANAGERS, 'MANAGER');
    await gate(true);

    const r = await sync(playerId, incomplete([]));

    expect(r).toMatchObject({ changed: false, gateDenied: false, effectiveRole: 'PLAYER' });
    expect(await roleOf(playerId)).toBe('PLAYER');
    expect(await audits()).toHaveLength(0);
  });

  it('denies when the gate is on and nothing matched', async () => {
    await mapGroup(GROUP_MANAGERS, 'MANAGER');
    await gate(true);

    const r = await sync(playerId, complete(['unmapped']));

    expect(r.gateDenied).toBe(true);
  });

  it('does not deny when the gate is off', async () => {
    await mapGroup(GROUP_MANAGERS, 'MANAGER');
    await gate(false);

    expect((await sync(playerId, complete(['unmapped']))).gateDenied).toBe(false);
  });

  it('does not deny when the club has no provider row at all', async () => {
    // Defaulting the gate on for an unconfigured club would lock out everyone
    // at every club that enabled Entra before finishing directory setup.
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    expect((await sync(playerId, complete(['unmapped']))).gateDenied).toBe(false);
  });

  it('is a no-op for a club with no mappings', async () => {
    await enableEntra();
    const r = await sync(playerId, complete([GROUP_MANAGERS]));

    expect(r).toMatchObject({ changed: false, gateDenied: false });
    expect(await audits()).toHaveLength(0);
  });

  it('writes nothing when the role already matches', async () => {
    await enableEntra();
    await mapGroup(GROUP_MANAGERS, 'MANAGER');
    await sync(playerId, complete([GROUP_MANAGERS]));

    const r = await sync(playerId, complete([GROUP_MANAGERS]));

    expect(r.changed).toBe(false);
    // One audit row from the first sync, not two — an unchanged sync that
    // still wrote a row would make the trail unreadable at every sign-in.
    expect(await audits()).toHaveLength(1);
  });

  it('applies the highest-priority mapping when several match', async () => {
    await enableEntra();
    await mapGroup(GROUP_MANAGERS, 'MANAGER', 10);
    await mapGroup(GROUP_COACHES, 'COACH', 90);

    await sync(playerId, complete([GROUP_MANAGERS, GROUP_COACHES]));

    expect(await roleOf(playerId)).toBe('COACH');
  });

  it('DOES apply a mapping that lowers a role — matching is not the same as silence', async () => {
    // Pinned after review caught the file's own header claiming "only ever
    // raised, never lowered" while the code wrote any differing role.
    //
    // Lowering on a MATCH is correct: a mapping says "people in this group hold
    // this role", and refusing to lower would make a mapping unable to correct
    // an over-promotion — the main reason anyone edits one. What must never
    // happen is demotion by SILENCE, which the test above covers.
    await enableEntra();
    await mapGroup(GROUP_COACHES, 'STAFF');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.updateMany({
        where: { userId: playerId, tenantId: tenant.tenantId },
        data: { role: 'MANAGER' },
      }),
    );

    const r = await sync(playerId, complete([GROUP_COACHES]));

    expect(r.changed).toBe(true);
    expect(await roleOf(playerId)).toBe('STAFF');
  });

  it('does nothing at all when Entra federation is disabled', async () => {
    // `enabled` was previously never read anywhere in the codebase, so
    // switching a club's integration off changed nothing.
    await enableEntra();
    await asAppSuperuser(db, (tx) =>
      tx.tenantIdentityProvider.updateMany({
        where: { tenantId: tenant.tenantId },
        data: { enabled: false },
      }),
    );
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    const r = await sync(playerId, complete([GROUP_MANAGERS]));

    expect(r.changed).toBe(false);
    expect(await roleOf(playerId)).toBe('PLAYER');
  });

  it('a disabled federation does not deny either', async () => {
    await enableEntra(true);
    await asAppSuperuser(db, (tx) =>
      tx.tenantIdentityProvider.updateMany({
        where: { tenantId: tenant.tenantId },
        data: { enabled: false },
      }),
    );

    expect((await sync(playerId, complete([]))).gateDenied).toBe(false);
  });

  it('still enforces the gate when the club has NO mappings', async () => {
    // Deleting the last mapping used to turn the gate off silently: the sync
    // returned early on `mappings.length === 0` before the gate was read.
    // "You must be in a mapped group" with no mapped groups admits nobody.
    await enableEntra(true);

    expect((await sync(playerId, complete(['anything']))).gateDenied).toBe(true);
  });

  it('the OWNER can still get in to fix a club gated with no mappings', async () => {
    // The escape hatch that makes the rule above safe rather than a lockout.
    await enableEntra(true);

    expect((await sync(tenant.userId, complete([]))).gateDenied).toBe(false);
  });

  it('a corrupt config does not switch the gate off', async () => {
    // The gate flag is read off the raw JSON, so a malformed unrelated field
    // cannot disable a security control by failing validation.
    await asAppSuperuser(db, (tx) =>
      tx.tenantIdentityProvider.create({
        data: {
          tenantId: tenant.tenantId,
          type: 'ENTRA_ID',
          enabled: true,
          configJson: { aadTenantId: 'not-a-uuid', clientId: 42, enforceGroupGate: true },
        },
      }),
    );
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    expect((await sync(playerId, complete(['unmapped']))).gateDenied).toBe(true);
  });

  it('ignores group ids issued by a DIFFERENT Entra directory', async () => {
    // One sign-in resolves one group list, from whichever directory the user
    // authenticated against, and it is then offered to every club they belong
    // to. Without this, club B would match ids issued by club A's directory
    // against its own mappings.
    await enableEntra();
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    const foreign = {
      ...complete([GROUP_MANAGERS]),
      directoryTenantId: '99999999-9999-4999-8999-999999999999',
    };

    const r = await sync(playerId, foreign);

    expect(r.changed).toBe(false);
    expect(await roleOf(playerId)).toBe('PLAYER');
  });

  it('does not DENY on a foreign directory — that would lock out a multi-club member', async () => {
    await enableEntra(true);
    await mapGroup(GROUP_MANAGERS, 'MANAGER');

    const foreign = { ...complete([]), directoryTenantId: '99999999-9999-4999-8999-999999999999' };

    expect((await sync(playerId, foreign)).gateDenied).toBe(false);
  });
});
