import { isHTTPAccessFallbackError } from 'next/dist/client/components/http-access-fallback/http-access-fallback';

import { loadClubPublicPage } from '@/app-layer/usecases/club-public-page';
import ClubPublicPage from '@/app/(public)/clubs/[slug]/page';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The public club page's data (#356), against a real database: one ACTIVE
 * club by slug and ONLY its ACTIVE venues, read through the same BYPASSRLS
 * binding the page uses — `venue_org` and `venue` are FORCE row security, so a
 * wrong binding would read as "this club has no venues", not as an error.
 */
describe('the public club page (#356)', () => {
  const db = prismaTestClient();

  async function venueFor(
    tenantId: string,
    slug: string,
    o: {
      status?: 'ACTIVE' | 'SUSPENDED';
      sport?: 'PADEL' | 'TENNIS';
      courtStatus?: 'ACTIVE' | 'SUSPENDED';
    } = {},
  ) {
    return asAppSuperuser(db, async (tx) => {
      const v = await tx.venue.create({
        data: {
          tenantId,
          slug,
          status: o.status ?? 'ACTIVE',
          name: `Venue ${slug}`,
          addressLine: 'ул. Корт 1',
          city: 'Sofia',
          email: `${slug}@playerz.test`,
          phone: '+359 2 123 456',
          lat: 42.6977,
          lng: 23.3219,
        },
      });
      if (o.sport) {
        await tx.resource.create({
          data: {
            tenantId,
            venueId: v.id,
            name: 'Корт 1',
            sport: o.sport,
            surface: 'HARD',
            basePriceCents: 2400,
            status: o.courtStatus ?? 'ACTIVE',
          },
        });
      }
      return tx.venue.findUniqueOrThrow({
        where: { id: v.id },
        select: { id: true, publicSlug: true },
      });
    });
  }

  const setClubStatus = (tenantId: string, status: 'SUSPENDED' | 'CLOSED') =>
    asAppSuperuser(db, (tx) => tx.venueOrg.update({ where: { id: tenantId }, data: { status } }));

  it('lists every ACTIVE venue of an ACTIVE club, and none of anyone else’s', async () => {
    const club = await seedTenant();
    const other = await seedTenant();
    const first = await venueFor(club.tenantId, 'cp-first', { sport: 'PADEL' });
    const second = await venueFor(club.tenantId, 'cp-second', { sport: 'TENNIS' });
    await venueFor(club.tenantId, 'cp-suspended', { status: 'SUSPENDED', sport: 'PADEL' });
    await venueFor(other.tenantId, 'cp-other', { sport: 'PADEL' });

    const page = await runAsSuperuser((tx) => loadClubPublicPage(tx, club.tenantSlug));

    expect(page).not.toBeNull();
    expect(page!.slug).toBe(club.tenantSlug);
    // Oldest first: the first is the main venue, whose address the page shows.
    expect(page!.venues.map((v) => v.id)).toEqual([first.id, second.id]);
    expect(page!.venues.map((v) => v.publicSlug)).toEqual([first.publicSlug, second.publicSlug]);
    expect(page!.venues.map((v) => v.sports)).toEqual([['PADEL'], ['TENNIS']]);
    // The seeded club has no phone of its own: the main venue's.
    expect(page!.phone).toBe('+359 2 123 456');
  });

  it('a club with one venue still lists it; a court that is not ACTIVE is not its sport', async () => {
    const club = await seedTenant();
    await venueFor(club.tenantId, 'cp-only', { sport: 'TENNIS', courtStatus: 'SUSPENDED' });

    const page = await runAsSuperuser((tx) => loadClubPublicPage(tx, club.tenantSlug));
    expect(page!.venues).toHaveLength(1);
    expect(page!.venues[0]!.sports).toEqual([]);
  });

  it('a club with no venue yet is a page with none, not a 404', async () => {
    const club = await seedTenant();
    const page = await runAsSuperuser((tx) => loadClubPublicPage(tx, club.tenantSlug));
    expect(page).toMatchObject({ slug: club.tenantSlug, venues: [] });
  });

  it.each(['SUSPENDED', 'CLOSED'] as const)(
    'a %s club has no page: null, and the page is notFound()',
    async (status) => {
      const club = await seedTenant();
      await venueFor(club.tenantId, `cp-${status.toLowerCase()}`, { sport: 'PADEL' });
      await setClubStatus(club.tenantId, status);

      await expect(
        runAsSuperuser((tx) => loadClubPublicPage(tx, club.tenantSlug)),
      ).resolves.toBeNull();

      const thrown = await ClubPublicPage({
        params: Promise.resolve({ slug: club.tenantSlug }),
      }).catch((e: unknown) => e);
      expect(isHTTPAccessFallbackError(thrown)).toBe(true);
    },
  );

  it('no such club, or a slug no club could have, is notFound() before any read', async () => {
    for (const slug of ['no-such-club-anywhere', 'Not A Slug!', '../etc']) {
      const thrown = await ClubPublicPage({ params: Promise.resolve({ slug }) }).catch(
        (e: unknown) => e,
      );
      expect(isHTTPAccessFallbackError(thrown)).toBe(true);
    }
  });
});
