import { resolveEntraGroupClaims } from '@/lib/auth/entra-group-claims';
import { resolveRoleFromGroups } from '@/lib/auth/entra-role-mapping';

const m = (aadGroupId: string, role: string, priority = 0) =>
  ({ aadGroupId, role, priority }) as never;

describe('resolveRoleFromGroups', () => {
  it('returns the mapped role for a matched group', () => {
    expect(resolveRoleFromGroups(['g1'], [m('g1', 'MANAGER')])).toEqual({
      role: 'MANAGER',
      matchedGroupIds: ['g1'],
    });
  });

  it('highest priority wins, not highest seniority', () => {
    // The administrator's explicit priority is the primary signal. A club may
    // deliberately want a narrow group to beat a broad one.
    const r = resolveRoleFromGroups(
      ['broad', 'narrow'],
      [m('broad', 'MANAGER', 10), m('narrow', 'STAFF', 90)],
    );

    expect(r.role).toBe('STAFF');
  });

  it('breaks an equal-priority tie deterministically by seniority', () => {
    // Without a tie-break the answer depends on row order, so a user's role
    // would change when Postgres changed its mind about a scan — impossible
    // to support and impossible to reproduce.
    const a = resolveRoleFromGroups(['g1', 'g2'], [m('g1', 'STAFF', 5), m('g2', 'MANAGER', 5)]);
    const b = resolveRoleFromGroups(['g1', 'g2'], [m('g2', 'MANAGER', 5), m('g1', 'STAFF', 5)]);

    expect(a.role).toBe('MANAGER');
    expect(b.role).toBe(a.role);
  });

  it('reports EVERY matched group, not just the winner', () => {
    // The audit entry records what the decision was made from, and the gate
    // asks "did any mapped group match?" — the winner alone answers neither.
    const r = resolveRoleFromGroups(['g1', 'g2'], [m('g1', 'MANAGER', 9), m('g2', 'PLAYER', 1)]);

    expect(r.matchedGroupIds.sort()).toEqual(['g1', 'g2']);
  });

  it('returns null when nothing matches', () => {
    expect(resolveRoleFromGroups(['other'], [m('g1', 'MANAGER')])).toEqual({
      role: null,
      matchedGroupIds: [],
    });
  });

  it('is empty-safe on both sides', () => {
    expect(resolveRoleFromGroups([], [m('g1', 'MANAGER')]).role).toBeNull();
    expect(resolveRoleFromGroups(['g1'], []).role).toBeNull();
  });
});

describe('resolveEntraGroupClaims', () => {
  it('reads the groups claim off the token', async () => {
    await expect(
      resolveEntraGroupClaims({ profile: { groups: ['g1', 'g2'] }, accessToken: 't' }),
    ).resolves.toEqual({
      groups: ['g1', 'g2'],
      source: 'token',
      overage: false,
      complete: true,
      directoryTenantId: null,
    });
  });

  it('an ABSENT claim is complete-and-empty, not unknown', () => {
    // No overage pointer means the token carried the whole list, including
    // when that list is empty. Reporting incomplete here would disable the
    // gate for every club whose members are genuinely in no mapped group.
    return expect(
      resolveEntraGroupClaims({ profile: {}, accessToken: 't' }),
    ).resolves.toMatchObject({ groups: [], complete: true });
  });

  it('survives a non-array groups claim instead of throwing into sign-in', async () => {
    await expect(
      resolveEntraGroupClaims({ profile: { groups: 'not-an-array' }, accessToken: 't' }),
    ).resolves.toMatchObject({ groups: [], complete: true });
  });

  it('calls Graph when Entra signals overage', async () => {
    const fetchGroups = jest.fn().mockResolvedValue({ groups: ['g1'], complete: true });

    const r = await resolveEntraGroupClaims(
      { profile: { _claim_names: { groups: 'src1' } }, accessToken: 'tok' },
      { fetchGroups },
    );

    expect(fetchGroups).toHaveBeenCalledWith('tok');
    expect(r).toEqual({
      groups: ['g1'],
      source: 'graph',
      overage: true,
      complete: true,
      directoryTenantId: null,
    });
  });

  it('overage with NO access token is incomplete — never an empty list', async () => {
    // The pointer exists precisely because the user is in many groups, so
    // "no groups" is the one answer we know to be false. Returning [] as if it
    // were complete is how the ported implementation would deny a user who is
    // in more mapped groups than anyone else at the club.
    const r = await resolveEntraGroupClaims({
      profile: { _claim_names: { groups: 'src1' } },
      accessToken: null,
    });

    expect(r).toEqual({
      groups: [],
      source: 'none',
      overage: true,
      complete: false,
      directoryTenantId: null,
    });
  });

  it('propagates an incomplete Graph result rather than flattening it', async () => {
    const fetchGroups = jest.fn().mockResolvedValue({ groups: ['g1'], complete: false });

    const r = await resolveEntraGroupClaims(
      { profile: { _claim_names: { groups: 'src1' } }, accessToken: 'tok' },
      { fetchGroups },
    );

    expect(r.complete).toBe(false);
  });

  it('carries the directory id off the tid claim, lower-cased', async () => {
    // Group ids mean nothing without the directory that issued them: one
    // sign-in's list is offered to every club the user belongs to.
    const r = await resolveEntraGroupClaims({
      profile: { groups: ['g1'], tid: 'ABCDEF00-0000-4000-8000-000000000000' },
      accessToken: 't',
    });

    expect(r.directoryTenantId).toBe('abcdef00-0000-4000-8000-000000000000');
  });

  it('matches group ids case-insensitively', () => {
    // Entra emits lower-case GUIDs, but an admin pasting one from a portal
    // that upper-cases it would otherwise store a mapping that looks
    // configured and silently grants nothing.
    const r = resolveRoleFromGroups(
      ['0F8FAD5B-D9CB-469F-A165-70867728950E'],
      [m('0f8fad5b-d9cb-469f-a165-70867728950e', 'MANAGER')],
    );

    expect(r.role).toBe('MANAGER');
  });
});
