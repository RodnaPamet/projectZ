import { prisma } from './create-isolated-tenant';

/**
 * A club with one venue and one court a player can book from the venue page
 * (#355). Straight to Prisma, for `createIsolatedTenant`'s reason.
 *
 * The court is open 08:00–22:00 every day at the club (Europe/Sofia), books in
 * 60-minute units up to 120, on the hour — so TOMORROW always has free times,
 * whatever time of day the spec runs. The venue name carries a random tag so
 * `/venues?q=` finds exactly this card among everything the seed holds.
 */
export interface BookableVenue {
  tenantId: string;
  clubSlug: string;
  venueId: string;
  venueName: string;
  publicSlug: string;
}

export async function seedBookableVenue(): Promise<BookableVenue> {
  const tag = Math.random().toString(36).slice(2, 10);
  const clubSlug = `e2e-vb-${tag}`;
  const venueName = `E2E Падел ${tag}`;

  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    const org = await tx.venueOrg.create({
      data: {
        name: `E2E ${clubSlug}`,
        slug: clubSlug,
        contactEmail: `${clubSlug}@playerz.test`,
        city: 'Sofia',
        tenantTestRun: clubSlug,
      },
    });
    const venue = await tx.venue.create({
      data: {
        tenantId: org.id,
        slug: `e2e-vb-venue-${tag}`,
        name: venueName,
        addressLine: 'ул. Корт 1',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `${clubSlug}@playerz.test`,
        timezone: 'Europe/Sofia',
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId: org.id,
        venueId: venue.id,
        name: 'Корт 1',
        sport: 'PADEL',
        surface: 'ARTIFICIAL_GRASS',
        basePriceCents: 2400,
        minBookingMinutes: 60,
        maxBookingMinutes: 120,
        slotStepMinutes: 60,
      },
    });
    await tx.resourceAvailability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        tenantId: org.id,
        resourceId: court.id,
        dayOfWeek,
        openTime: new Date('1970-01-01T08:00:00Z'),
        closeTime: new Date('1970-01-01T22:00:00Z'),
      })),
    });

    const row = await tx.venue.findUniqueOrThrow({
      where: { id: venue.id },
      select: { publicSlug: true },
    });

    return {
      tenantId: org.id,
      clubSlug,
      venueId: venue.id,
      venueName,
      publicSlug: row.publicSlug!,
    };
  });
}

/**
 * Remove what `seedBookableVenue` made, and the membership booking created.
 * `booking.tenantId` and `venue.tenantId` are not foreign keys, so they go
 * first. Best effort, like `destroyPlayer`.
 */
export async function destroyBookableVenue(v: BookableVenue): Promise<void> {
  try {
    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.booking.deleteMany({ where: { tenantId: v.tenantId } });
      await tx.venue.deleteMany({ where: { tenantId: v.tenantId } });
      await tx.venueOrg.deleteMany({ where: { id: v.tenantId } });
    });
  } catch (err) {
    console.warn(`e2e: could not delete club ${v.clubSlug}: ${(err as Error).message}`);
  }
}
