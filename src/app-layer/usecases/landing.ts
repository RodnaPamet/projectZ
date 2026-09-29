import type { PrismaClient } from '@prisma/client';

import {
  decideLanding,
  landingContexts,
  type LandingContext,
  type LandingDecision,
  type LandingMembership,
} from '@/lib/auth/landing';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * The reads and the one write behind role landing (#227). The decision itself
 * is `@/lib/auth/landing`, pure; this is what feeds it.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * A person's roles span every club, and `tenant_membership` carries FORCE row
 * security keyed on `app.tenant_id` alone. There is no binding that means "my
 * memberships, everywhere": bound as `app_user` with no tenant the read returns
 * ZERO ROWS, which here would read as "holds no club role" and land an owner
 * on the player UI — plausible, silent, wrong. `auth.ts` reads the same rows at
 * sign-in the same way, for the same reason.
 *
 * Every query is scoped by `userId`, which callers take from a verified
 * session and never from a request. It can only ever describe the person
 * asking, and it cannot enumerate. The one write is to that person's own
 * `app_user` row, by primary key.
 *
 * ═══ WHY NOT THE TOKEN'S MEMBERSHIP LIST ═══
 *
 * It is a mint-time snapshot, capped at fifty, and it carries neither the
 * club's status nor its name. A club suspended since sign-in would still be
 * offered, and the switcher would have nothing to label an entry with.
 */

/**
 * How many club-role memberships are read.
 *
 * PLAYER rows are not read at all — the player context is universal and they
 * add nothing — so this bounds OWNER/MANAGER/STAFF/COACH memberships only. A
 * person running more than a hundred clubs would see the first hundred they
 * joined in the switcher, and a warning is logged, rather than an unbounded
 * read on every page that renders the header.
 */
export const MAX_LANDING_MEMBERSHIPS = 100;

async function readMemberships(db: PrismaClient, userId: string): Promise<LandingMembership[]> {
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
    logger.warn('landing: club-role memberships hit the read cap; the switcher is truncated', {
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

/** Where this person should land now. What `/start` redirects to. */
export async function resolveLanding(userId: string): Promise<LandingDecision> {
  const { memberships, lastUsed } = await runAsSuperuser(async (db) => {
    const memberships = await readMemberships(db, userId);
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { lastContext: true },
    });
    return { memberships, lastUsed: user?.lastContext ?? null };
  });

  return decideLanding({ memberships, lastUsed });
}

/**
 * Every context this person holds, for the switcher.
 *
 * Separate from `resolveLanding` because the header renders on every page and
 * has no use for the last-used value — it marks the CURRENT context from the
 * URL, not the remembered one.
 */
export async function listLandingContexts(userId: string): Promise<LandingContext[]> {
  const memberships = await runAsSuperuser((db) => readMemberships(db, userId));
  return landingContexts(memberships);
}

/**
 * Record a switcher choice, and say where it leads.
 *
 * The key is checked against the contexts the person holds RIGHT NOW, inside
 * the same transaction as the write. So the only values that can ever reach
 * `lastContext` are keys this code produced for this person — a forged
 * `club:<someone else's club>` is refused here rather than stored and ignored
 * later.
 *
 * Returns null when the key names nothing they hold: a stale switcher (the
 * membership was suspended after the page rendered), or a request that never
 * came from one.
 */
export async function rememberLandingContext(
  userId: string,
  key: string,
): Promise<LandingContext | null> {
  return runAsSuperuser(async (db) => {
    const chosen = landingContexts(await readMemberships(db, userId)).find((c) => c.key === key);
    if (!chosen) return null;

    await db.user.update({
      where: { id: userId },
      data: { lastContext: chosen.key },
      select: { id: true },
    });

    return chosen;
  });
}
