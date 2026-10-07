import type { Role } from '@prisma/client';

import { countActiveOwners, listStaff } from '@/app-layer/repositories/staff';
import {
  CannotChangeOwnRoleError,
  changeMemberRole,
  LastOwnerError,
  MembershipAccountKindError,
  OwnerManagementRequiredError,
  RoleChangesAccountKindError,
  setMemberSuspended,
  StaffMemberNotFoundError,
} from '@/app-layer/usecases/staff';
import { kindForRole } from '@/lib/auth/account-kind';
import { membershipContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * WHO RUNS A CLUB, AND THE WAYS THAT CAN GO WRONG.
 *
 * Every refusal here prevents a specific, plausible, hard-to-undo mistake:
 *
 *   the last owner   a club nobody can administer, unrecoverable without
 *                    platform support
 *   yourself         the usual route to the above, even with two owners
 *   OWNER either way needs admin.owner_management, which a MANAGER lacks
 *
 * Nothing in the database enforces any of them. The `role <> 'OWNER'` CHECK
 * from P27 is on `tenant_entra_group_mapping` only, so this use case is the
 * whole control — which is exactly why it is tested against a real database
 * rather than reasoned about.
 */

describe('admin staff', () => {
  const db = prismaTestClient();

  /**
   * A second person at the club, with a role — and the KIND of account that
   * role belongs to (#263), which the database insists on.
   */
  async function member(tenantId: string, tag: string, role: Role) {
    const user = await asAppSuperuser(db, (tx) =>
      tx.user.create({
        data: {
          email: `${tag}-${tenantId.slice(-6)}@test.invalid`,
          name: `Person ${tag}`,
          accountKind: kindForRole(role),
        },
        select: { id: true },
      }),
    );
    const m = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId, userId: user.id, role: role as never, status: 'ACTIVE' },
        select: { id: true },
      }),
    );
    return { userId: user.id, membershipId: m.id };
  }

  const owner = (userId: string) => ({ userId, canManageOwners: true });
  const manager = (userId: string) => ({ userId, canManageOwners: false });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: lists this club’s members with their roles, across the RLS boundary', async () => {
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    await member(mine.tenantId, 'coach', 'COACH');
    await member(theirs.tenantId, 'theirs', 'MANAGER');

    const rows = await runInTenantContext(mine.tenantId, (c) => listStaff(c, mine.tenantId));

    // The seeded owner plus the coach — and nobody from the other club.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role).sort()).toEqual(['COACH', 'OWNER']);
    expect(rows.every((r) => r.email.length > 0)).toBe(true);
  });

  it('lists staff only: a PLAYER membership is not a member of the staff (#349)', async () => {
    // Booking makes a player a PLAYER member of the club (#229), so a busy
    // club's staff screen filled up with everybody who had booked a court.
    const t = await seedTenant({}, db);
    await member(t.tenantId, 'coach', 'COACH');
    await member(t.tenantId, 'desk', 'STAFF');
    await member(t.tenantId, 'mgr', 'MANAGER');
    const booker = await member(t.tenantId, 'booker', 'PLAYER');

    const rows = await runInTenantContext(t.tenantId, (c) => listStaff(c, t.tenantId));

    expect(rows.map((r) => r.role).sort()).toEqual(['COACH', 'MANAGER', 'OWNER', 'STAFF']);
    expect(rows.some((r) => r.userId === booker.userId)).toBe(false);
  });

  it('REFUSES to demote the last active owner', async () => {
    // ═══ THE LOCKOUT ═══
    //
    // A club with no owner cannot change roles, manage payouts, or recover
    // without platform support. One click, and the customer cannot undo it.
    const t = await seedTenant({}, db);
    const other = await member(t.tenantId, 'other', 'MANAGER');
    const ownerRow = await runInTenantContext(t.tenantId, async (c) => {
      const all = await listStaff(c, t.tenantId);
      return all.find((r) => r.role === 'OWNER')!;
    });

    expect(await runInTenantContext(t.tenantId, (c) => countActiveOwners(c, t.tenantId))).toBe(1);

    await expect(
      runInTenantContext(t.tenantId, (c) =>
        // Acting as the OTHER person, so the self-check is not what refuses it.
        changeMemberRole(c, t.tenantId, owner(other.userId), ownerRow.membershipId, 'MANAGER'),
      ),
    ).rejects.toThrow(LastOwnerError);

    // Still an owner, and still able to administer.
    const ctx = await membershipContext(ownerRow.userId, t.tenantSlug);
    expect(ctx.kind === 'ok' && ctx.ctx.role).toBe('OWNER');
  });

  it('ALLOWS demoting an owner once a second one exists', async () => {
    // The guard is about the last one, not about owners generally.
    const t = await seedTenant({}, db);
    const second = await member(t.tenantId, 'second', 'OWNER');
    const first = await runInTenantContext(t.tenantId, async (c) =>
      (await listStaff(c, t.tenantId)).find((r) => r.userId === t.userId)!,
    );

    expect(await runInTenantContext(t.tenantId, (c) => countActiveOwners(c, t.tenantId))).toBe(2);

    await runInTenantContext(t.tenantId, (c) =>
      changeMemberRole(c, t.tenantId, owner(second.userId), first.membershipId, 'MANAGER'),
    );

    expect(await runInTenantContext(t.tenantId, (c) => countActiveOwners(c, t.tenantId))).toBe(1);
  });

  it('REFUSES to suspend the last active owner', async () => {
    // Same lockout by a different door: SUSPENDED is not ACTIVE, and
    // resolveTenantPageContext treats anything but ACTIVE as not-a-member.
    const t = await seedTenant({}, db);
    const other = await member(t.tenantId, 'other', 'MANAGER');
    const ownerRow = await runInTenantContext(t.tenantId, async (c) =>
      (await listStaff(c, t.tenantId)).find((r) => r.role === 'OWNER')!,
    );

    await expect(
      runInTenantContext(t.tenantId, (c) =>
        setMemberSuspended(c, t.tenantId, owner(other.userId), ownerRow.membershipId, true),
      ),
    ).rejects.toThrow(LastOwnerError);
  });

  it('REFUSES to change your own role, even as an owner', async () => {
    // The usual route to a lockout even with two owners: the second is away,
    // the first demotes themselves to test something.
    const t = await seedTenant({}, db);
    await member(t.tenantId, 'second', 'OWNER');
    const self = await runInTenantContext(t.tenantId, async (c) =>
      (await listStaff(c, t.tenantId)).find((r) => r.userId === t.userId)!,
    );

    await expect(
      runInTenantContext(t.tenantId, (c) =>
        changeMemberRole(c, t.tenantId, owner(t.userId), self.membershipId, 'MANAGER'),
      ),
    ).rejects.toThrow(CannotChangeOwnRoleError);
  });

  it.each([
    ['granting ownership', 'OWNER'],
    ['removing ownership', 'MANAGER'],
  ])('REFUSES %s without admin.owner_management', async (_label, target) => {
    // ROLE_PERMISSIONS gives admin.owner_management to OWNER and explicitly
    // not to MANAGER. Nothing in the database enforces it — the P27 CHECK is
    // on the Entra mapping table only.
    const t = await seedTenant({}, db);
    const mgr = await member(t.tenantId, 'mgr', 'MANAGER');
    // A STAFF member to promote: a role change stays within one kind of
    // account (#263), so ownership is granted to somebody already on the staff.
    const subject =
      target === 'OWNER'
        ? await member(t.tenantId, 'staff', 'STAFF')
        : await member(t.tenantId, 'owner2', 'OWNER');

    await expect(
      runInTenantContext(t.tenantId, (c) =>
        changeMemberRole(c, t.tenantId, manager(mgr.userId), subject.membershipId, target as never),
      ),
    ).rejects.toThrow(OwnerManagementRequiredError);
  });

  it('a manager CAN change roles below owner', async () => {
    // The permission split has to let the ordinary case through, or a club
    // with a manager cannot run itself.
    const t = await seedTenant({}, db);
    const mgr = await member(t.tenantId, 'mgr', 'MANAGER');
    const staff = await member(t.tenantId, 'staff', 'STAFF');

    const after = await runInTenantContext(t.tenantId, (c) =>
      changeMemberRole(c, t.tenantId, manager(mgr.userId), staff.membershipId, 'MANAGER'),
    );
    expect(after.role).toBe('MANAGER');
  });

  it.each([
    ['a PLAYER made STAFF', 'PLAYER', 'STAFF'],
    ['STAFF made a PLAYER', 'STAFF', 'PLAYER'],
    ['a COACH made a MANAGER', 'COACH', 'MANAGER'],
    ['a PLAYER made a COACH', 'PLAYER', 'COACH'],
  ] as const)('REFUSES %s — another kind of account (#263)', async (_label, from, to) => {
    // One account, one kind: this is never a role change, it is a second
    // account, which the club gets by inviting the person. Refused before the
    // write, with nothing changed and nothing audited.
    const t = await seedTenant({}, db);
    const subject = await member(t.tenantId, 'subject', from);

    await expect(
      runInTenantContext(t.tenantId, (c) =>
        changeMemberRole(c, t.tenantId, owner(t.userId), subject.membershipId, to),
      ),
    ).rejects.toThrow(RoleChangesAccountKindError);

    const row = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.findUniqueOrThrow({
        where: { id: subject.membershipId },
        select: { role: true },
      }),
    );
    expect(row.role).toBe(from);
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.auditEntry.count({ where: { tenantId: t.tenantId, action: 'MEMBER_ROLE_CHANGED' } }),
      ),
    ).toBe(0);
  });

  it('REFUSES reinstating a club account that has joined another club since (#263)', async () => {
    // The one refusal only the DATABASE can make here: the other club's rows
    // are behind row security in this club's transaction. The trigger sees
    // them, and the use case says what happened.
    const t = await seedTenant({}, db);
    const other = await seedTenant({}, db);
    const staff = await member(t.tenantId, 'staff', 'STAFF');

    await runInTenantContext(t.tenantId, (c) =>
      setMemberSuspended(c, t.tenantId, owner(t.userId), staff.membershipId, true),
    );
    // Meanwhile, the same club account goes to work somewhere else.
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: other.tenantId, userId: staff.userId, role: 'STAFF', status: 'ACTIVE' },
      }),
    );

    const refusal = runInTenantContext(t.tenantId, (c) =>
      setMemberSuspended(c, t.tenantId, owner(t.userId), staff.membershipId, false),
    );
    await expect(refusal).rejects.toThrow(MembershipAccountKindError);
    await expect(refusal).rejects.toMatchObject({ rule: 'one_club' });

    const row = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.findUniqueOrThrow({
        where: { id: staff.membershipId },
        select: { status: true },
      }),
    );
    expect(row.status).toBe('SUSPENDED');
  });

  it('suspension takes effect on the next request, and is reversible', async () => {
    // SUSPENDED rather than deleted: the row is referenced by bookings,
    // sessions and audit entries, and the page resolver already treats
    // anything but ACTIVE as not-a-member.
    const t = await seedTenant({}, db);
    const coach = await member(t.tenantId, 'coach', 'COACH');

    expect((await membershipContext(coach.userId, t.tenantSlug)).kind).toBe('ok');

    await runInTenantContext(t.tenantId, (c) =>
      setMemberSuspended(c, t.tenantId, owner(t.userId), coach.membershipId, true),
    );
    expect((await membershipContext(coach.userId, t.tenantSlug)).kind).toBe('not-a-member');

    await runInTenantContext(t.tenantId, (c) =>
      setMemberSuspended(c, t.tenantId, owner(t.userId), coach.membershipId, false),
    );
    expect((await membershipContext(coach.userId, t.tenantSlug)).kind).toBe('ok');
  });

  it('cannot touch a membership at another club', async () => {
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const theirCoach = await member(theirs.tenantId, 'coach', 'COACH');

    await expect(
      runInTenantContext(mine.tenantId, (c) =>
        changeMemberRole(c, mine.tenantId, owner(mine.userId), theirCoach.membershipId, 'MANAGER'),
      ),
    ).rejects.toThrow(StaffMemberNotFoundError);
  });

  it('records every change, with the role it was before', async () => {
    const t = await seedTenant({}, db);
    const staff = await member(t.tenantId, 'staff', 'STAFF');

    await runInTenantContext(t.tenantId, (c) =>
      changeMemberRole(c, t.tenantId, owner(t.userId), staff.membershipId, 'MANAGER'),
    );

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirst({
        where: { tenantId: t.tenantId, action: 'MEMBER_ROLE_CHANGED' },
        select: { actorUserId: true, detailsJson: true },
      }),
    );
    expect(audit?.actorUserId).toBe(t.userId);
    const d = audit!.detailsJson as { before?: { role?: string }; after?: { role?: string } };
    expect(d.before?.role).toBe('STAFF');
    expect(d.after?.role).toBe('MANAGER');
  });
});
