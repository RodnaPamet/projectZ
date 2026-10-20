import { prisma } from './create-isolated-tenant';
import type { BookableVenue } from './seed-bookable-venue';

/**
 * Put the bookable venue's court on a plan (#625): a 20 × 10 m padel court
 * around the venue's point, drawn by the club, so the plan shows it alone and
 * the middle of the canvas is the middle of the court. Gone with the court.
 */
export async function drawTheCourt(venue: BookableVenue) {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.resource.updateMany({
      where: { venueId: venue.venueId },
      data: {
        planOutline: [
          [-10, -5],
          [10, -5],
          [10, 5],
          [-10, 5],
        ],
        planSource: 'CLUB',
      },
    });
  });
}
