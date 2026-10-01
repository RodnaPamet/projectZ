import type { PrismaClient } from '@prisma/client';

import { decideLanding, type LandingDecision, type LandingMembership } from '@/lib/auth/landing';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * The reads behind landing (#227, by account kind since #263). The decision
 * itself is `@/lib/auth/landing`, pure; this is what feeds it.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * A club account's one club, or an undecided account's several, can be any
 * club, and `tenant_membership` carries FORCE row security keyed on
 * `app.tenant_id` alone. There is no binding that means "my memberships,
 * everywhere": bound as `app_user` with no tenant the read returns ZERO ROWS,
 * which here would read as "has no club" and land an owner on the home page —
 * plausible, silent, wrong. `auth.ts` reads the same rows at sign-in the same
 * way, for the same reason.
 *
 * Every query is scoped by `userId`, which callers take from a verified
 * session and never from a request. It can only ever describe the person
 * asking, and it cannot enumerate. It writes nothing: the switcher and its
 * `lastContext` column are gone (#263), because one kind has nothing to switch
 * between.
 *
 * ═══ WHY NOT THE TOKEN ═══
 *
 * The token's membership list is a mint-time snapshot, capped at fifty, and it
 * carries neither the club's status nor its name — and since #250 nothing
 * reads it to decide anything.
 */

/**
 * How many club-role and coach memberships are read.
 *
 * A CLUB account has one, by the database's own rule. More belong only to an
 * account the migration left undecided; past a hundred, the first hundred
 * joined are considered and a warning is logged, rather than an unbounded read
 * on every page that renders the header.
 */
export const MAX_LANDING_MEMBERSHIPS = 100;

/**
 * Exported for `usecases/me`, which answers `GET /api/v1/me` from the same
 * rows in the same transaction as the account it describes — so the kind and
 * the landing it reports cannot come from two different reads.
 */
export async function readMemberships(
  db: PrismaClient,
  userId: string,
): Promise<LandingMembership[]> {
  const rows = await db.tenantMembership.findMany({
    // The status filters narrow the read; `decideLanding` applies the same
    // rules again, because it is the contract and other callers reach it
    // without this query in front of it.
    where: {
      userId,
      role: { not: 'PLAYER' },
      status: 'ACTIVE',
      tenant: { status: 'ACTIVE' },
    },
    select: {
      role: true,
      status: true,
      createdAt: true,
      tenant: { select: { id: true, slug: true, name: true, status: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { tenantId: 'asc' }],
    take: MAX_LANDING_MEMBERSHIPS,
  });

  if (rows.length === MAX_LANDING_MEMBERSHIPS) {
    logger.warn('landing: club-role memberships hit the read cap', {
      component: 'landing',
      userId,
      cap: MAX_LANDING_MEMBERSHIPS,
    });
  }

  return rows.map((m) => ({
    tenantId: m.tenant.id,
    tenantSlug: m.tenant.slug,
    tenantName: m.tenant.name,
    role: m.role,
    status: m.status,
    tenantStatus: m.tenant.status,
    createdAt: m.createdAt,
  }));
}

/**
 * Where this person lands now. What `/start` redirects to, and what the site
 * header links back to.
 *
 * A PLAYER account is answered from the account row alone: its memberships are
 * all PLAYER rows, which decide nothing, so the header of every page a player
 * sees costs one indexed read, not two.
 */
export async function resolveLanding(userId: string): Promise<LandingDecision> {
  const input = await runAsSuperuser(async (db) => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { accountKind: true },
    });

    // A session whose account row is gone lands as a player: there is nothing
    // else it could be, and every page it reaches resolves its own access.
    if (!user || user.accountKind === 'PLAYER') {
      return { kind: 'PLAYER' as const, memberships: [] };
    }

    return { kind: user.accountKind, memberships: await readMemberships(db, userId) };
  });

  return decideLanding(input);
}
