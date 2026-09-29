import { checkTenantAccess } from '@/lib/auth/guard';
import {
  MAX_JWT_MEMBERSHIPS,
  buildMembershipClaims,
  type MembershipClaim,
} from '@/lib/auth/jwt-claims';

const mk = (n: number): MembershipClaim[] =>
  Array.from({ length: n }, (_, i) => ({
    tenantId: `t${i}`,
    tenantSlug: `club-${i}`,
    role: 'PLAYER',
  }));

describe('JWT membership claims', () => {
  it('carries every membership when under the cap', () => {
    const { memberships, membershipsTruncated } = buildMembershipClaims(mk(10));
    expect(memberships).toHaveLength(10);
    expect(membershipsTruncated).toBe(false);
  });

  it('caps at MAX_JWT_MEMBERSHIPS and flags the truncation', () => {
    // A JWT rides in a cookie on EVERY request. Past ~4KB it does not throw
    // — the cookie is silently dropped and the user is mysteriously logged
    // out. That bug appears only for your most engaged users.
    const { memberships, membershipsTruncated } = buildMembershipClaims(mk(60));
    expect(memberships).toHaveLength(MAX_JWT_MEMBERSHIPS);
    expect(membershipsTruncated).toBe(true);
  });

  it('does not flag truncation at exactly the cap', () => {
    expect(buildMembershipClaims(mk(MAX_JWT_MEMBERSHIPS)).membershipsTruncated).toBe(false);
  });
});

describe('a truncated list must not lock a player out of their 51st club', () => {
  it('defers to the database instead of denying', () => {
    const all = mk(60);
    const { memberships, membershipsTruncated } = buildMembershipClaims(all);

    // club-55 IS a real membership — it just fell off the end of the token.
    const token = { sub: 'u1', memberships, membershipsTruncated };

    const decision = checkTenantAccess('/t/club-55/dashboard', token);

    // Denying here would be a permissions bug that only the most engaged
    // players ever hit, and it would look like "you're not a member" rather
    // than "your token overflowed".
    expect(decision).toEqual({ kind: 'needs_db_check', tenantSlug: 'club-55' });
  });

  it('still allows a club that IS in the visible slice', () => {
    const { memberships, membershipsTruncated } = buildMembershipClaims(mk(60));
    expect(
      checkTenantAccess('/t/club-3/dashboard', { sub: 'u1', memberships, membershipsTruncated })
        .kind,
    ).toBe('allow');
  });

  it('an UNtruncated list defers too, because complete is not the same as current (#250)', () => {
    // This used to be a hard `forbidden`, on the grounds that deferring
    // everything would stop the edge guarding. The list is complete only as of
    // SIGN-IN: #229 joins a player to a club by booking, after which the club
    // is missing from a list that is not truncated. So the deferral IS blanket
    // now — and the guarding moved, not vanished: every tenant route resolves
    // the membership from the database and enforces the permission table there
    // (`tenant-routes-resolve-membership` pins it).
    const { memberships, membershipsTruncated } = buildMembershipClaims(mk(3));
    expect(
      checkTenantAccess('/t/other-club/x', { sub: 'u1', memberships, membershipsTruncated }).kind,
    ).toBe('needs_db_check');
  });
});
