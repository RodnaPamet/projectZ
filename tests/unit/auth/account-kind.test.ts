import type { Role } from '@prisma/client';

import {
  CLUB_ROLES,
  decideInviteAcceptance,
  decideOwnerAssignment,
  kindForRole,
  roleChangeKeepsKind,
  type AccountStanding,
} from '@/lib/auth/account-kind';

/**
 * ONE ACCOUNT, ONE KIND (#263) — THE RULES.
 *
 *   "it's either or - player or club owner/manager/staff - using both requires
 *    two separate accounts … club accounts only relate to one club … coach …
 *    a third type of account altogether"
 *
 * These are the rules the APPLICATION applies, so that a refusal comes with a
 * message. The database applies the same ones without a message — see
 * tests/integration/account-kinds.test.ts, which drives the trigger directly.
 */

const account = (over: Partial<AccountStanding>): AccountStanding => ({
  kind: 'PLAYER',
  clubTenantIds: [],
  isEmpty: false,
  ...over,
});

const BRAND_NEW = account({ kind: 'PLAYER', isEmpty: true });
const PLAYS_SOMEWHERE = account({ kind: 'PLAYER' });
const CLUB_WITHOUT_A_CLUB = account({ kind: 'CLUB' });
const CLUB_OF_THIS = account({ kind: 'CLUB', clubTenantIds: ['ct_this'] });
const CLUB_OF_ANOTHER = account({ kind: 'CLUB', clubTenantIds: ['ct_other'] });
const COACH = account({ kind: 'COACH' });
const UNDECIDED = account({ kind: null, clubTenantIds: ['ct_a', 'ct_b'] });

describe('kindForRole', () => {
  it.each([
    ['OWNER', 'CLUB'],
    ['MANAGER', 'CLUB'],
    ['STAFF', 'CLUB'],
    ['COACH', 'COACH'],
    ['PLAYER', 'PLAYER'],
  ] as const)('%s belongs to a %s account', (role, kind) => {
    expect(kindForRole(role)).toBe(kind);
  });

  it('the club roles are exactly the three that run a club', () => {
    expect([...CLUB_ROLES]).toEqual(['OWNER', 'MANAGER', 'STAFF']);
  });
});

describe('roleChangeKeepsKind — a role change stays within one kind', () => {
  const ROLES: Role[] = ['OWNER', 'MANAGER', 'STAFF', 'COACH', 'PLAYER'];

  it('allows every change among club roles', () => {
    for (const from of CLUB_ROLES) {
      for (const to of CLUB_ROLES) expect(roleChangeKeepsKind(from, to)).toBe(true);
    }
  });

  it('refuses every change that crosses kinds, in both directions', () => {
    const crossing = ROLES.flatMap((from) =>
      ROLES.filter((to) => kindForRole(from) !== kindForRole(to)).map((to) => [from, to]),
    );
    // 3 club roles × 2 other kinds × 2 directions + PLAYER ↔ COACH twice.
    expect(crossing).toHaveLength(14);
    for (const [from, to] of crossing) expect(roleChangeKeepsKind(from!, to!)).toBe(false);
  });
});

describe('decideInviteAcceptance — a STAFF or MANAGER invite', () => {
  const staffInvite = { role: 'STAFF' as const, tenantId: 'ct_this' };

  it('a brand-new account accepts it, and becomes a CLUB account', () => {
    expect(decideInviteAcceptance(BRAND_NEW, staffInvite)).toEqual({ ok: true, becomes: 'CLUB' });
  });

  it('a club account with no club yet accepts it as it is', () => {
    expect(decideInviteAcceptance(CLUB_WITHOUT_A_CLUB, staffInvite)).toEqual({
      ok: true,
      becomes: null,
    });
  });

  it('…and so does this club’s own club account (re-invited, say as MANAGER)', () => {
    expect(decideInviteAcceptance(CLUB_OF_THIS, { role: 'MANAGER', tenantId: 'ct_this' })).toEqual({
      ok: true,
      becomes: null,
    });
  });

  it('a player who plays anywhere is told to use a SEPARATE account', () => {
    // Converting it would end its player memberships — not a decision for a
    // click on an invite.
    expect(decideInviteAcceptance(PLAYS_SOMEWHERE, staffInvite)).toEqual({
      ok: false,
      refusal: 'SEPARATE_ACCOUNT_REQUIRED',
    });
  });

  it('another club’s account is told it already belongs to a club', () => {
    expect(decideInviteAcceptance(CLUB_OF_ANOTHER, staffInvite)).toEqual({
      ok: false,
      refusal: 'CLUB_ACCOUNT_TAKEN',
    });
  });

  it('a coach account is told to use a separate account', () => {
    expect(decideInviteAcceptance(COACH, staffInvite)).toEqual({
      ok: false,
      refusal: 'SEPARATE_ACCOUNT_REQUIRED',
    });
  });
});

describe('decideInviteAcceptance — PLAYER and COACH invites', () => {
  it('a PLAYER invite is accepted by any player account, brand new or not', () => {
    const invite = { role: 'PLAYER' as const, tenantId: 'ct_this' };
    expect(decideInviteAcceptance(BRAND_NEW, invite)).toEqual({ ok: true, becomes: null });
    expect(decideInviteAcceptance(PLAYS_SOMEWHERE, invite)).toEqual({ ok: true, becomes: null });
  });

  it.each([
    ['a club account', CLUB_OF_ANOTHER],
    ['a club account with no club', CLUB_WITHOUT_A_CLUB],
    ['a coach account', COACH],
  ])('a PLAYER invite is refused to %s — accept it with your player account', (_l, acc) => {
    expect(decideInviteAcceptance(acc, { role: 'PLAYER', tenantId: 'ct_this' })).toEqual({
      ok: false,
      refusal: 'PLAYER_ACCOUNT_REQUIRED',
    });
  });

  it('a COACH invite is accepted by a coach account', () => {
    expect(decideInviteAcceptance(COACH, { role: 'COACH', tenantId: 'ct_this' })).toEqual({
      ok: true,
      becomes: null,
    });
  });

  it('a COACH invite converts NOBODY, a brand-new account included — that is the coach flow', () => {
    expect(decideInviteAcceptance(BRAND_NEW, { role: 'COACH', tenantId: 'ct_this' })).toEqual({
      ok: false,
      refusal: 'COACH_ACCOUNT_REQUIRED',
    });
  });
});

describe('decideInviteAcceptance — an account the migration left undecided', () => {
  it.each(['STAFF', 'PLAYER', 'COACH'] as const)('is refused a %s invite', (role) => {
    expect(decideInviteAcceptance(UNDECIDED, { role, tenantId: 'ct_a' })).toEqual({
      ok: false,
      refusal: 'ACCOUNT_KIND_UNDECIDED',
    });
  });
});

describe('a brand-new account that has not chosen player or coach yet (#360)', () => {
  const NOT_CHOSEN = account({ kind: null, isEmpty: true });

  it.each([
    ['STAFF', 'CLUB'],
    ['MANAGER', 'CLUB'],
    ['PLAYER', 'PLAYER'],
    ['COACH', 'COACH'],
  ] as const)('accepts a %s invite and becomes %s: the invitation is its answer', (role, kind) => {
    expect(decideInviteAcceptance(NOT_CHOSEN, { role, tenantId: 'ct_this' })).toEqual({
      ok: true,
      becomes: kind,
    });
  });

  it('can be made an owner, and becomes CLUB', () => {
    expect(decideOwnerAssignment(NOT_CHOSEN, 'ct_this')).toEqual({ ok: true, becomes: 'CLUB' });
  });
});

describe('decideOwnerAssignment — who create-venue-org may make an owner', () => {
  it('a brand-new account, which becomes CLUB', () => {
    expect(decideOwnerAssignment(BRAND_NEW, 'ct_this')).toEqual({ ok: true, becomes: 'CLUB' });
  });

  it('a club account with no club, or this club’s — re-running is a no-op', () => {
    expect(decideOwnerAssignment(CLUB_WITHOUT_A_CLUB, 'ct_this')).toEqual({
      ok: true,
      becomes: null,
    });
    expect(decideOwnerAssignment(CLUB_OF_THIS, 'ct_this')).toEqual({ ok: true, becomes: null });
  });

  it.each([
    ['a player who plays anywhere', PLAYS_SOMEWHERE, 'PLAYER_ACCOUNT'],
    ['a coach', COACH, 'COACH_ACCOUNT'],
    ['another club’s account', CLUB_OF_ANOTHER, 'CLUB_ACCOUNT_TAKEN'],
    ['an undecided account', UNDECIDED, 'UNDECIDED'],
  ] as const)('refuses %s', (_label, acc, refusal) => {
    expect(decideOwnerAssignment(acc, 'ct_this')).toEqual({ ok: false, refusal });
  });
});
