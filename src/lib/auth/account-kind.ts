import type { AccountKind, Role } from '@prisma/client';

/**
 * One account, one kind (#263) — the rules, as pure functions.
 *
 * ═══ THE OWNER'S DECISION ═══
 *
 *   "it's either or - player or club owner/manager/staff - using both requires
 *    two separate accounts … club accounts only relate to one club … coach …
 *    a third type of account altogether … with own booking system and
 *    affiliate clubs."
 *
 *   kind     memberships it may hold ACTIVE
 *   ──────   ────────────────────────────────────────────────────────
 *   PLAYER   PLAYER, at any number of clubs (joined by booking, #229)
 *   CLUB     OWNER / MANAGER / STAFF, at ONE club
 *   COACH    COACH, at the clubs it is affiliated with
 *
 * ═══ WHERE THIS IS ENFORCED ═══
 *
 * Twice, deliberately. These functions decide what the APPLICATION refuses, so
 * that a refusal comes with a message somebody can act on: "accept this with a
 * separate account" rather than a 500. The database refuses the same mixes
 * with no message at all, for every writer this file never sees — the
 * `account_kind_membership_trg` trigger from the p37 migration.
 *
 * No import but types, so a page, a client component and a script can all ask
 * the same question.
 *
 * ═══ UNDECIDED ═══
 *
 * `accountKind` is NULL for the accounts the migration would not decide: club
 * roles at two or more clubs, or a COACH role. Every rule here that GRANTS
 * something refuses them — a person decides which account they are, and until
 * then nothing adds to the mix. Rules that take something away (suspending,
 * demoting within club roles) still apply to them.
 */

/** The account a role belongs to. OWNER, MANAGER and STAFF run a club. */
export function kindForRole(role: Role): AccountKind {
  switch (role) {
    case 'OWNER':
    case 'MANAGER':
    case 'STAFF':
      return 'CLUB';
    case 'COACH':
      return 'COACH';
    case 'PLAYER':
      return 'PLAYER';
  }
}

/** Club roles, highest first. */
export const CLUB_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const satisfies readonly Role[];

/**
 * May a membership move from `from` to `to` on the same account?
 *
 * Only within one kind: OWNER ↔ MANAGER ↔ STAFF, never PLAYER ↔ STAFF or
 * COACH ↔ anything. A club turning one of its players into staff is exactly
 * the mix the owner ruled out — the player needs a separate club account, and
 * the club invites that.
 */
export function roleChangeKeepsKind(from: Role, to: Role): boolean {
  return kindForRole(from) === kindForRole(to);
}

/** What an account holds, as far as these rules need to know. */
export interface AccountStanding {
  kind: AccountKind | null;
  /** Clubs where it holds an ACTIVE OWNER / MANAGER / STAFF membership. */
  clubTenantIds: readonly string[];
  /**
   * No membership of any kind or status, ever — a brand-new account. The one
   * account that may still become something other than what it was created
   * as: nothing has been decided by it yet.
   */
  isEmpty: boolean;
}

/**
 * Why an account may not do something, as a stable code a UI and a client can
 * translate. Every one of them is about the CALLER's own account — never about
 * the club — so answering it tells nobody anything about which clubs exist.
 */
export type AccountKindRefusal =
  /** Booking, or a PLAYER invite: needs a PLAYER account. */
  | 'PLAYER_ACCOUNT_REQUIRED'
  /** A staff invite, to an account that is a player, or a coach: two accounts. */
  | 'SEPARATE_ACCOUNT_REQUIRED'
  /** A staff invite, to a club account that already belongs to another club. */
  | 'CLUB_ACCOUNT_TAKEN'
  /** A COACH invite: needs a COACH account, which only the coach flow creates. */
  | 'COACH_ACCOUNT_REQUIRED'
  /** The account was not decided by the migration; a person must settle it first. */
  | 'ACCOUNT_KIND_UNDECIDED';

export type InviteAcceptance =
  { ok: true; becomes: AccountKind | null } | { ok: false; refusal: AccountKindRefusal };

/**
 * May this account accept an invitation to `role` at `tenantId`?
 *
 * The owner's rule for staff invites: "accepted only by a CLUB account with no
 * club yet, or by a brand-new account (which becomes CLUB)". A PLAYER account
 * that has played anywhere is told to accept with a separate account, because
 * turning it into a club account would end its player memberships — a
 * decision this click is not the place to make.
 *
 * `becomes` is the kind the account must be switched to first: CLUB for an
 * empty account accepting a staff invite, otherwise null (it already fits).
 *
 * A COACH invite converts no account that has a kind. An empty account that
 * has not chosen yet (#360) is the one exception: see below.
 */
export function decideInviteAcceptance(
  account: AccountStanding,
  invite: { role: Role; tenantId: string },
): InviteAcceptance {
  // ═══ A BRAND-NEW ACCOUNT HAS NOT CHOSEN YET (#360) ═══
  //
  // Since #360 a first sign-in is NULL until the person answers "player or
  // coach?". An invitation is itself that answer, for an account that holds
  // nothing: a staff invite makes it CLUB, as it made an empty player CLUB
  // before; a player or coach invite makes it that kind. Only an undecided
  // account that HOLDS something (P37's mixed accounts) is still refused.
  if (account.kind === null) {
    return account.isEmpty
      ? { ok: true, becomes: kindForRole(invite.role) }
      : { ok: false, refusal: 'ACCOUNT_KIND_UNDECIDED' };
  }

  switch (kindForRole(invite.role)) {
    case 'CLUB': {
      if (account.kind === 'CLUB') {
        const elsewhere = account.clubTenantIds.some((id) => id !== invite.tenantId);
        return elsewhere
          ? { ok: false, refusal: 'CLUB_ACCOUNT_TAKEN' }
          : { ok: true, becomes: null };
      }
      if (account.kind === 'PLAYER' && account.isEmpty) return { ok: true, becomes: 'CLUB' };
      return { ok: false, refusal: 'SEPARATE_ACCOUNT_REQUIRED' };
    }

    case 'PLAYER':
      return account.kind === 'PLAYER'
        ? { ok: true, becomes: null }
        : { ok: false, refusal: 'PLAYER_ACCOUNT_REQUIRED' };

    case 'COACH':
      return account.kind === 'COACH'
        ? { ok: true, becomes: null }
        : { ok: false, refusal: 'COACH_ACCOUNT_REQUIRED' };
  }
}

export type OwnerAssignment =
  | { ok: true; becomes: AccountKind | null }
  | { ok: false; refusal: 'PLAYER_ACCOUNT' | 'COACH_ACCOUNT' | 'CLUB_ACCOUNT_TAKEN' | 'UNDECIDED' };

/**
 * May this account be made the OWNER of `tenantId`? `create-venue-org`'s rule:
 * a CLUB account with no other club, or a brand-new account, which becomes
 * CLUB. Absent entirely is decided by the caller — that account is created as
 * CLUB.
 */
export function decideOwnerAssignment(account: AccountStanding, tenantId: string): OwnerAssignment {
  // An empty account that has not chosen yet (#360) becomes CLUB, like an
  // empty player; one that holds something is for a person to decide.
  if (account.kind === null) {
    return account.isEmpty ? { ok: true, becomes: 'CLUB' } : { ok: false, refusal: 'UNDECIDED' };
  }
  if (account.kind === 'COACH') return { ok: false, refusal: 'COACH_ACCOUNT' };

  if (account.kind === 'CLUB') {
    const elsewhere = account.clubTenantIds.some((id) => id !== tenantId);
    return elsewhere ? { ok: false, refusal: 'CLUB_ACCOUNT_TAKEN' } : { ok: true, becomes: null };
  }

  return account.isEmpty ? { ok: true, becomes: 'CLUB' } : { ok: false, refusal: 'PLAYER_ACCOUNT' };
}
