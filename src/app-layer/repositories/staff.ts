import type { PrismaClient, Role } from '@prisma/client';

/**
 * The people who run a club.
 *
 * ═══ THE SAME RLS-CROSSING JOIN AS PLAYERS, FOR THE SAME REASON ═══
 *
 * `tenant_membership` is tenant-scoped with FORCE row security; `app_user` is
 * global and carries no policy. So: read the memberships, which RLS constrains
 * to this club, then read the users those rows name. Starting from users would
 * be a platform-wide scan filtered in application code.
 *
 * Unlike `PlayerVenueRelationship`, `TenantMembership` DOES declare a relation
 * to `User` — but following it would hand Prisma the join, and the join is the
 * thing worth keeping explicit here.
 */

export const STAFF_LIST_LIMIT = 200;

export interface StaffMember {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  status: string;
  acceptedAt: Date | null;
}

/**
 * Everyone with a membership at this club, staff and players alike.
 *
 * PLAYER rows are included deliberately: promoting a regular into a coach is
 * the ordinary way a club gains staff, and a screen that only showed existing
 * staff would give no way to do it — with invites unavailable (#199), it would
 * give no way to add anyone at all.
 */
export async function listStaff(db: PrismaClient, tenantId: string): Promise<StaffMember[]> {
  const memberships = await db.tenantMembership.findMany({
    where: { tenantId },
    select: { id: true, userId: true, role: true, status: true, acceptedAt: true },
    orderBy: [{ role: 'asc' }, { id: 'asc' }],
    take: STAFF_LIST_LIMIT,
  });

  if (memberships.length === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: memberships.map((m) => m.userId) } },
    select: { id: true, name: true, email: true },
    take: STAFF_LIST_LIMIT,
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return memberships.map((m) => ({
    membershipId: m.id,
    userId: m.userId,
    name: byId.get(m.userId)?.name ?? null,
    email: byId.get(m.userId)?.email ?? '',
    role: m.role,
    status: m.status,
    acceptedAt: m.acceptedAt,
  }));
}

/**
 * How many ACTIVE owners the club has.
 *
 * The number that decides whether a demotion is allowed. Counted rather than
 * inferred from the list, because the list is capped at STAFF_LIST_LIMIT and a
 * club with 200+ members would be answering the question from a partial view.
 */
export async function countActiveOwners(db: PrismaClient, tenantId: string): Promise<number> {
  return db.tenantMembership.count({ where: { tenantId, role: 'OWNER', status: 'ACTIVE' } });
}
