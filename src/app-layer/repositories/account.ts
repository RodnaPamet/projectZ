import type { PrismaClient } from '@prisma/client';

import { CLUB_ROLES, type AccountStanding } from '@/lib/auth/account-kind';

/**
 * What an account IS, and holds, for the kind rules in `@/lib/auth/account-kind`.
 *
 * ═══ THE HANDLE MUST SEE EVERY CLUB ═══
 *
 * "Does this club account already belong to another club?" is a question
 * about every tenant at once, and `tenant_membership` carries FORCE row
 * security keyed on one. Bound to a tenant, this would see that tenant's rows
 * only and answer "no other club" for everybody — the one wrong answer that
 * matters. So the callers pass a BYPASSRLS handle: `acceptInvite` and the
 * invite page already hold one (the token is how the club is discovered),
 * `resolvePlayerTenant` holds one for the same reason, and `create-venue-org`
 * runs as the owner.
 *
 * Every read is by the `userId` of the person asking, from a verified session
 * or an operator's own command line. It cannot enumerate.
 *
 * Returns null for an account that does not exist.
 */
export async function readAccountStanding(
  db: PrismaClient,
  userId: string,
): Promise<AccountStanding | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { accountKind: true },
  });
  if (!user) return null;

  const [anyMembership, clubs] = await Promise.all([
    // Any status: an account that once played somewhere, or was once on a
    // club's staff, is no longer brand new.
    db.tenantMembership.findFirst({ where: { userId }, select: { id: true } }),
    db.tenantMembership.findMany({
      where: { userId, status: 'ACTIVE', role: { in: [...CLUB_ROLES] } },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
      // One for a CLUB account, by the database's own rule. More only for an
      // account the migration could not decide — and those are refused before
      // this list is read.
      take: 10,
    }),
  ]);

  return {
    kind: user.accountKind,
    clubTenantIds: clubs.map((c) => c.tenantId),
    isEmpty: anyMembership === null,
  };
}
