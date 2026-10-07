import type { PrismaClient, Role } from '@prisma/client';

import { countActiveOwners } from '@/app-layer/repositories/staff';
import { roleChangeKeepsKind } from '@/lib/auth/account-kind';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { accountKindViolation, type AccountKindRule } from '@/lib/db/pg-errors';

/**
 * Changing who runs a club.
 *
 * ═══ THE THREE REFUSALS, AND WHY EACH ONE EXISTS ═══
 *
 * **The last owner.** Demoting or deactivating the only ACTIVE owner leaves a
 * club nobody can administer — no role changes, no payouts, no way back
 * without a platform admin reaching in. It is a one-click, irreversible-by-the-
 * customer mistake, and the obvious person to make it is a sole owner tidying
 * up their own account.
 *
 * **Yourself.** Changing your own role is how the above happens even with more
 * than one owner: the second owner is on holiday, the first demotes themselves
 * to test something. It is also the only change nobody else has to agree to.
 *
 * **OWNER, in either direction.** Granting or removing ownership needs
 * `admin.owner_management`, which `ROLE_PERMISSIONS` gives to OWNER and
 * explicitly not to MANAGER — the comment there says so. `admin.staff_manage`
 * covers everything below that line.
 *
 * Note what does NOT protect this: the `role <> 'OWNER'` CHECK from P27 is on
 * `tenant_entra_group_mapping` only, a table nothing has written since #361
 * removed the Entra sync. Nothing at the database level stops a membership
 * becoming OWNER, so this is the whole control.
 *
 * ═══ AND ONE ABOUT THE ACCOUNT (#263) ═══
 *
 * **Another kind of account.** A player is not promoted to staff, and staff are
 * not demoted to players: one account is one kind, so either would be a second
 * account, which the club gets by inviting the person. That one IS enforced by
 * the database as well — `account_kind_membership_trg` — and it is the only
 * layer that can see what an account holds at OTHER clubs, which is why a
 * reinstatement can be refused by it with no check here first.
 */

export class StaffMemberNotFoundError extends Error {
  constructor() {
    super('No such member at this club.');
    this.name = 'StaffMemberNotFoundError';
  }
}

export class LastOwnerError extends Error {
  constructor() {
    super(
      'This is the club’s only active owner. Promote somebody else first — a club with no ' +
        'owner cannot change roles, manage payouts, or recover without platform support.',
    );
    this.name = 'LastOwnerError';
  }
}

export class CannotChangeOwnRoleError extends Error {
  constructor() {
    super(
      'You cannot change your own role. Ask another owner — it is the one change with ' +
        'nobody else in the loop, and the usual way a club loses its last administrator.',
    );
    this.name = 'CannotChangeOwnRoleError';
  }
}

export class OwnerManagementRequiredError extends Error {
  constructor() {
    super(
      'Granting or removing ownership needs admin.owner_management, which a manager does ' +
        'not hold. admin.staff_manage covers every role below owner.',
    );
    this.name = 'OwnerManagementRequiredError';
  }
}

/**
 * A role from another KIND of account (#263): a PLAYER made STAFF, a STAFF
 * made a PLAYER, anything to or from COACH.
 *
 * One account is one kind, so this is never a role change — it is a second
 * account. The club invites that person instead, and they accept with a club
 * account. Checked here, before the write, so the staff screen can say so; the
 * database refuses it anyway (`account_kind_membership_trg`).
 */
export class RoleChangesAccountKindError extends Error {
  constructor(from: Role, to: Role) {
    super(
      `${from} → ${to} would move this membership to another kind of account. Player, club and ` +
        'coach are separate accounts (#263): invite the person, and they accept with the right one.',
    );
    this.name = 'RoleChangesAccountKindError';
  }
}

/**
 * The database refused the write because of the account behind the membership
 * (#263) — typically reinstating somebody whose club account has since joined
 * another club (`one_club`), or whose account was never a club account at all.
 * The application cannot see either from inside one club's transaction: the
 * other club's rows are behind row security. The trigger can.
 */
export class MembershipAccountKindError extends Error {
  constructor(public readonly rule: AccountKindRule) {
    super(`The account behind this membership does not allow it (${rule}, #263).`);
    this.name = 'MembershipAccountKindError';
  }
}

/** Translate the account-kind trigger's refusal; rethrow everything else unchanged. */
function refusedByAccountKind(err: unknown): never {
  const rule = accountKindViolation(err);
  if (rule) throw new MembershipAccountKindError(rule);
  throw err;
}

async function membership(db: PrismaClient, tenantId: string, membershipId: string) {
  const m = await db.tenantMembership.findFirst({
    where: { id: membershipId, tenantId },
    select: { id: true, userId: true, role: true, status: true },
  });
  if (!m) throw new StaffMemberNotFoundError();
  return m;
}

export async function changeMemberRole(
  db: PrismaClient,
  tenantId: string,
  actor: { userId: string; canManageOwners: boolean },
  membershipId: string,
  role: Role,
) {
  const before = await membership(db, tenantId, membershipId);

  if (before.userId === actor.userId) throw new CannotChangeOwnRoleError();

  if (!roleChangeKeepsKind(before.role, role)) {
    throw new RoleChangesAccountKindError(before.role, role);
  }

  // Either direction. Removing an owner is as consequential as adding one.
  if ((before.role === 'OWNER' || role === 'OWNER') && !actor.canManageOwners) {
    throw new OwnerManagementRequiredError();
  }

  if (before.role === 'OWNER' && role !== 'OWNER') {
    // Counted, not inferred from a capped list.
    if ((await countActiveOwners(db, tenantId)) <= 1) throw new LastOwnerError();
  }

  if (before.role === role) return before;

  const after = await db.tenantMembership
    .update({
      where: { id: membershipId },
      data: { role },
      select: { id: true, userId: true, role: true, status: true },
    })
    .catch(refusedByAccountKind);

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: actor.userId,
    entity: 'TenantMembership',
    entityId: membershipId,
    action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
    details: `Role for ${before.userId} changed from ${before.role} to ${role}`,
    detailsJson: {
      category: 'access',
      summary: 'Member role changed',
      before: { role: before.role },
      after: { role },
    },
  });

  return after;
}

/**
 * Suspend a member, or bring them back.
 *
 * SUSPENDED, never deleted. The row is referenced by bookings, audit entries
 * and sessions, and `resolveTenantPageContext` already treats anything other
 * than ACTIVE as "not a member" — so suspension takes effect on their next
 * request without destroying the history of what they did.
 */
export async function setMemberSuspended(
  db: PrismaClient,
  tenantId: string,
  actor: { userId: string; canManageOwners: boolean },
  membershipId: string,
  suspended: boolean,
) {
  const before = await membership(db, tenantId, membershipId);

  if (before.userId === actor.userId) throw new CannotChangeOwnRoleError();
  if (before.role === 'OWNER' && !actor.canManageOwners) throw new OwnerManagementRequiredError();

  if (suspended && before.role === 'OWNER') {
    if ((await countActiveOwners(db, tenantId)) <= 1) throw new LastOwnerError();
  }

  const status = suspended ? 'SUSPENDED' : 'ACTIVE';
  // Reinstating is the one direction that can break an account's kind: the
  // person may have joined another club since, with the same club account.
  // Only the database can see that from inside this club's transaction, and it
  // refuses — see `MembershipAccountKindError`.
  const after = await db.tenantMembership
    .update({
      where: { id: membershipId },
      data: { status, deactivatedAt: suspended ? new Date() : null },
      select: { id: true, userId: true, role: true, status: true },
    })
    .catch(refusedByAccountKind);

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: actor.userId,
    entity: 'TenantMembership',
    entityId: membershipId,
    action: suspended ? AUDIT_ACTIONS.MEMBER_REMOVED : AUDIT_ACTIONS.MEMBER_REINSTATED,
    details: `Member ${before.userId} ${suspended ? 'suspended' : 'reinstated'}`,
    detailsJson: {
      category: 'access',
      summary: suspended ? 'Member suspended' : 'Member reinstated',
      before: { status: before.status },
      after: { status },
    },
  });

  return after;
}
