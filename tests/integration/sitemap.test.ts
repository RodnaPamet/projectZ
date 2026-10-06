import sitemap from '@/app/sitemap';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * /sitemap.xml against a real database (#396): every public venue page of an
 * ACTIVE club, and none of a SUSPENDED or CLOSED one's — whose venue rows are
 * still `status: ACTIVE`, which is the trap (#298).
 */
describe('sitemap.xml (#396)', () => {
  const db = prismaTestClient();
  const saved = { SITE_URL: process.env.SITE_URL };

  beforeAll(() => {
    process.env.SITE_URL = 'https://playerz.example';
  });
  afterAll(() => {
    if (saved.SITE_URL === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = saved.SITE_URL;
  });

  async function venueFor(
    tenantId: string,
    slug: string,
    status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  ) {
    return asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId,
          slug,
          status,
          name: `Venue ${slug}`,
          addressLine: '1 Court St',
          city: 'Sofia',
          email: `${slug}@playerz.test`,
          lat: 42.6977,
          lng: 23.3219,
        },
        select: { publicSlug: true, updatedAt: true },
      }),
    );
  }

  async function setClubStatus(tenantId: string, status: 'SUSPENDED' | 'CLOSED') {
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: tenantId }, data: { status } }),
    );
  }

  it('lists ACTIVE clubs’ venues and leaves out SUSPENDED and CLOSED clubs’ venues', async () => {
    const open = await seedTenant();
    const suspended = await seedTenant();
    const closed = await seedTenant();

    const listed = await venueFor(open.tenantId, 'sm-open');
    const hiddenVenue = await venueFor(open.tenantId, 'sm-venue-suspended', 'SUSPENDED');
    const ofSuspended = await venueFor(suspended.tenantId, 'sm-club-suspended');
    const ofClosed = await venueFor(closed.tenantId, 'sm-club-closed');
    await setClubStatus(suspended.tenantId, 'SUSPENDED');
    await setClubStatus(closed.tenantId, 'CLOSED');

    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toContain('https://playerz.example/');
    expect(urls).toContain('https://playerz.example/venues');

    const own = entries.find(
      (e) => e.url === `https://playerz.example/venues/${listed.publicSlug}`,
    );
    expect(own).toBeDefined();
    expect(new Date(own!.lastModified!).getTime()).toBe(listed.updatedAt.getTime());

    for (const gone of [hiddenVenue, ofSuspended, ofClosed]) {
      expect(gone.publicSlug).toBeTruthy();
      expect(urls).not.toContain(`https://playerz.example/venues/${gone.publicSlug}`);
    }
  });

  it('puts the fixed pages first and every URL on SITE_URL', async () => {
    const entries = await sitemap();
    expect(entries.slice(0, 2).map((e) => e.url)).toEqual([
      'https://playerz.example/',
      'https://playerz.example/venues',
    ]);
    for (const e of entries.slice(2)) {
      expect(e.url).toMatch(/^https:\/\/playerz\.example\/(venues|clubs)\/[a-z0-9-]+$/);
    }
  });

  it('lists the club page of every club with a listed venue, and no SUSPENDED or CLOSED club (#356)', async () => {
    const open = await seedTenant();
    const empty = await seedTenant();
    const suspended = await seedTenant();
    const closed = await seedTenant();

    const listed = await venueFor(open.tenantId, 'smc-open');
    await venueFor(suspended.tenantId, 'smc-suspended');
    await venueFor(closed.tenantId, 'smc-closed');
    await setClubStatus(suspended.tenantId, 'SUSPENDED');
    await setClubStatus(closed.tenantId, 'CLOSED');

    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    const club = entries.find((e) => e.url === `https://playerz.example/clubs/${open.tenantSlug}`);
    expect(club).toBeDefined();
    // The newer of the club row and its newest venue.
    expect(new Date(club!.lastModified!).getTime()).toBeGreaterThanOrEqual(
      listed.updatedAt.getTime(),
    );
    // A club with no venue yet is an empty page: not offered to crawlers.
    expect(urls).not.toContain(`https://playerz.example/clubs/${empty.tenantSlug}`);
    for (const gone of [suspended, closed]) {
      expect(urls).not.toContain(`https://playerz.example/clubs/${gone.tenantSlug}`);
    }
  });
});
