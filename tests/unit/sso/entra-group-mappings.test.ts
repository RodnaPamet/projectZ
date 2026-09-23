import {
  ENTRA_MAPPABLE_ROLES,
  EntraGroupMappingCreateSchema,
  EntraGroupMappingUpdateSchema,
} from '@/app-layer/schemas/entra-group-mapping';
import { getPermissionsForRole } from '@/lib/permissions';
import { requiredPermission } from '@/lib/security/route-permissions';

const GROUP = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('what an Entra group may grant', () => {
  it('OWNER is not in the mappable set', () => {
    // The product decision, as a test. A mapping granting OWNER would make
    // club ownership transferable by editing an Active Directory group — by
    // directory admins, outside this application, who have no way to know that
    // OWNER can suspend the club and reassign ownership.
    expect(ENTRA_MAPPABLE_ROLES).not.toContain('OWNER');
    expect([...ENTRA_MAPPABLE_ROLES].sort()).toEqual(['COACH', 'MANAGER', 'PLAYER', 'STAFF']);
  });

  it('the schema refuses OWNER', () => {
    const r = EntraGroupMappingCreateSchema.safeParse({ aadGroupId: GROUP, role: 'OWNER' });
    expect(r.success).toBe(false);
  });

  it('accepts a mappable role and defaults priority to 0', () => {
    const r = EntraGroupMappingCreateSchema.safeParse({ aadGroupId: GROUP, role: 'MANAGER' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.priority).toBe(0);
  });

  it('requires a GUID, not a display name', () => {
    // A display name here would silently never match any `groups` claim: the
    // mapping would look configured and do nothing, which is the worst
    // possible failure mode for an access control.
    expect(
      EntraGroupMappingCreateSchema.safeParse({ aadGroupId: 'Sofia Admins', role: 'STAFF' })
        .success,
    ).toBe(false);
  });

  it.each([-1, 1001, 1.5])('rejects priority %s', (priority) => {
    expect(
      EntraGroupMappingCreateSchema.safeParse({ aadGroupId: GROUP, role: 'STAFF', priority })
        .success,
    ).toBe(false);
  });

  it('rejects an empty PATCH instead of returning a cheerful 200', () => {
    expect(EntraGroupMappingUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('who may configure them', () => {
  it('OWNER holds sso.manage and nobody else does', () => {
    // Pinned explicitly because the repo's spread at permissions.ts auto-grants
    // every new permission to OWNER, and the existing route-permission test
    // cannot detect an UNDER-granted permission. Without this, quietly adding
    // sso.manage to MANAGER later would fail nothing.
    expect(getPermissionsForRole('OWNER')).toContain('sso.manage');

    for (const role of ['MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const) {
      expect(getPermissionsForRole(role)).not.toContain('sso.manage');
    }
  });

  it.each(['POST', 'PATCH', 'DELETE'])('the edge requires sso.manage for %s', (method) => {
    expect(requiredPermission('/api/v1/t/sofia-padel/sso/entra/group-mappings', method)).toBe(
      'sso.manage',
    );
    expect(requiredPermission('/api/v1/t/sofia-padel/sso/entra/group-mappings/abc', method)).toBe(
      'sso.manage',
    );
  });

  it('the edge does NOT gate GET — which is why the handler checks too', () => {
    // requiredPermission returns null for every non-mutating method before it
    // reads the rules. The list of which directory group confers which role is
    // a map of how to gain admin access to the club, so the handler enforces
    // it rather than relying on an edge rule that structurally cannot fire.
    expect(requiredPermission('/api/v1/t/sofia-padel/sso/entra/group-mappings', 'GET')).toBeNull();
  });
});
