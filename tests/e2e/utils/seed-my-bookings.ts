import { prisma } from './create-isolated-tenant';

/**
 * A club where the E2E player has booked and played, for /me/bookings (T22).
 *
 * Straight to Prisma, for `createIsolatedTenant`'s reason. Two bookings at one
 * venue: one COMPLETED yesterday (the proof of visit, so it offers "rate this
 * venue") and one CONFIRMED tomorrow (which offers nothing). The player holds
 * an ACTIVE PLAYER membership, as booking would have given them: the v1 review
 * route resolves the club from the database and refuses a non-member with 404.
 *
 * The venue is in Europe/Sofia and the past booking starts at 16:00 UTC, so
 * the page must say 19:00 (EEST) or 18:00 (EET) — never 16:00.
 */
export interface PlayedClub {
  tenantId: string;
  slug: string;
  venueName: string;
  completedId: string;
  confirmedId: string;
}

const HOUR = 3_600_000;

function utcAt(daysFromToday: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

export async function seedPlayedClub(userId: string): Promise<PlayedClub> {
  const tag = Math.random().toString(36).slice(2, 10);
  const slug = `e2e-mb-${tag}`;
  const venueName = `E2E Корт ${tag}`;

  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    const org = await tx.venueOrg.create({
      data: {
        name: `E2E ${slug}`,
        slug,
        contactEmail: `${slug}@playerz.test`,
        city: 'Sofia',
        tenantTestRun: `e2e-mb-${tag}`,
      },
    });
    await tx.tenantMembership.create({
      data: { tenantId: org.id, userId, role: 'PLAYER', status: 'ACTIVE' },
    });
    const venue = await tx.venue.create({
      data: {
        tenantId: org.id,
        slug: `e2e-mb-venue-${tag}`,
        name: venueName,
        addressLine: '1 Court St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `${slug}@playerz.test`,
        timezone: 'Europe/Sofia',
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId: org.id,
        venueId: venue.id,
        name: 'Корт 1',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });

    const book = (start: Date, status: 'COMPLETED' | 'CONFIRMED') =>
      tx.booking.create({
        data: {
          tenantId: org.id,
          resourceId: court.id,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: userId,
          status,
          totalCents: 2400,
          idempotencyKey: `e2e-mb-${status}-${tag}`,
        },
      });

    const completed = await book(utcAt(-1, 16), 'COMPLETED');
    const confirmed = await book(utcAt(1, 16), 'CONFIRMED');

    return {
      tenantId: org.id,
      slug,
      venueName,
      completedId: completed.id,
      confirmedId: confirmed.id,
    };
  });
}

/**
 * Remove what `seedPlayedClub` made. `booking.tenantId` is not a foreign key,
 * so the bookings (and the review and moderation case left against them) do
 * not cascade from the club and go first. Best effort, like `destroyPlayer`.
 */
export async function destroyPlayedClub(club: PlayedClub, userId: string): Promise<void> {
  try {
    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      const reviews = await tx.review.findMany({
        where: { authorUserId: userId },
        select: { id: true },
      });
      await tx.moderationCase.deleteMany({
        where: { subjectId: { in: reviews.map((r) => r.id) } },
      });
      await tx.review.deleteMany({ where: { authorUserId: userId } });
      await tx.booking.deleteMany({ where: { tenantId: club.tenantId } });
      await tx.venue.deleteMany({ where: { tenantId: club.tenantId } });
      await tx.venueOrg.deleteMany({ where: { id: club.tenantId } });
    });
  } catch (err) {
    console.warn(`e2e: could not delete club ${club.slug}: ${(err as Error).message}`);
  }
}
