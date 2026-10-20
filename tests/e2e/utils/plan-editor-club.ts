import { prisma } from './create-isolated-tenant';
import type { IsolatedTenant } from './create-isolated-tenant';

/**
 * A club with one venue and one padel court not yet on its plan (#626), for
 * the plan editor's specs. Goes with the isolated tenant.
 */
export interface PlanClub {
  slug: string;
  venueId: string;
  courtId: string;
}

export async function seedPlanClub({ tenantId, tenantSlug }: IsolatedTenant): Promise<PlanClub> {
  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const venue = await tx.venue.create({
      data: {
        tenantId,
        slug: `${tenantSlug}-site`,
        name: 'Главен обект',
        addressLine: '1 Court St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `${tenantSlug}-site@playerz.test`,
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId,
        venueId: venue.id,
        name: 'Корт 1',
        sport: 'PADEL',
        surface: 'ARTIFICIAL_GRASS',
        basePriceCents: 2400,
      },
    });
    return { slug: tenantSlug, venueId: venue.id, courtId: court.id };
  });
}

/** The court's outline and where it came from, as saved. */
export async function savedOutline(courtId: string) {
  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.resource.findUniqueOrThrow({
      where: { id: courtId },
      select: { planOutline: true, planSource: true },
    });
  });
}
