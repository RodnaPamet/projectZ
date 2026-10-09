import { cache } from 'react';

import { runInTenantContext } from '@/lib/db/rls-middleware';
import { RESOURCE_TYPES, resourceNouns, type ResourceNouns } from '@/lib/sports/resource-kinds';

/**
 * WHAT A CLUB'S PLAYING PLACES ARE CALLED, AS A LIST (P51, #362).
 *
 * A karting club has tracks, not courts, and its admin says so: the nav item
 * and the bottom tab for the courts screen, and that screen's tab title, read
 * "Писти" when every resource the club has is a track, "Игрища" when every one
 * is a field, "Кортове и игрища" when it has courts and pitches (its nouns in
 * the order Кортове, игрища, писти), and "Кортове" otherwise (`resourceNouns`,
 * the one noun table, #454). The screen's own heading has followed
 * the same rule since P51, over the same rows: every resource the club has,
 * archived ones included, so the nav item never names a screen differently
 * from the heading it opens.
 *
 * One small read: the distinct resource types, at most one row per type.
 * Bound here, in the club's own context (`runInTenantContext`), with the
 * tenant id in the filter as well (`tenant-isolation-structural`), because its
 * callers are a layout and a component, which have no binding of their own to
 * hand it. Request-cached: the admin layout and the courts screen's title ask
 * in the same render.
 */
export const clubResourceNouns = cache(async (tenantId: string): Promise<ResourceNouns> =>
  resourceNouns(
    (
      await runInTenantContext(tenantId, (db) =>
        db.resource.findMany({
          where: { tenantId },
          select: { resourceType: true },
          distinct: ['resourceType'],
          orderBy: { resourceType: 'asc' },
          take: RESOURCE_TYPES.length,
        }),
      )
    ).map((r) => r.resourceType),
  ),
);
