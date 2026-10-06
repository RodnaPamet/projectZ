import type { PrismaClient } from '@prisma/client';

/**
 * The public page a club's admin links out to: "Публична страница ↗" (#347, #362).
 *
 * The club's own page, when there is one (#356, not built yet), and until then
 * its FIRST live venue's page, `/venues/{publicSlug}` (#355): the oldest active
 * venue, the id settling two made in the same millisecond. `publicSlug` is
 * unique across clubs (P41), so it names exactly that venue. A club with no
 * live venue yet has nothing of its own to show, and gets `null`; the caller
 * falls back to the venue list.
 *
 * Runs in the club's tenant context: venues are tenant-scoped, and the admin
 * asking is a member of this club.
 */
export async function clubFirstVenuePublicSlug(
  db: PrismaClient,
  tenantId: string,
): Promise<string | null> {
  const venue = await db.venue.findFirst({
    where: { tenantId, status: 'ACTIVE', publicSlug: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { publicSlug: true },
  });
  return venue?.publicSlug ?? null;
}
