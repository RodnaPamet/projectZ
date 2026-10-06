import type { PrismaClient } from '@prisma/client';

import { loadClubPublicPage } from '@/app-layer/usecases/club-public-page';
import {
  clubPublicHref,
  MODULE_HREFS,
  playerTabs,
  playerTopLinks,
} from '@/components/layout/nav-items';

/**
 * Where "Публична страница ↗" leads from a club's admin (#347, #362, #356),
 * the club page's read, and the module-gated entries of the player chrome, as
 * data. The read against a real database is
 * tests/integration/club-public-page.test.ts.
 */
describe('clubPublicHref', () => {
  it('the club’s own page, which lists every venue it runs (#356)', () => {
    expect(clubPublicHref('padel-lozenets')).toBe('/clubs/padel-lozenets');
  });

  it('escapes the slug, so a stored value cannot add a path segment', () => {
    expect(clubPublicHref('a/b')).toBe('/clubs/a%2Fb');
  });
});

describe('loadClubPublicPage', () => {
  function fakeDb(
    club: { status: string; contactPhone: string | null } | null,
    venues: Array<{ publicSlug: string | null; phone?: string | null; sports?: string[] }> = [],
  ) {
    const findUnique = jest
      .fn()
      .mockResolvedValue(
        club && { id: 'ct1', slug: 'alpha', name: 'Алфа', logoUrl: null, ...club },
      );
    const findMany = jest.fn().mockResolvedValue(
      venues.map((v, i) => ({
        id: `v${i}`,
        publicSlug: v.publicSlug,
        name: `Venue ${i}`,
        addressLine: 'ул. Корт 1',
        city: 'Sofia',
        country: 'BG',
        timezone: 'Europe/Sofia',
        phone: v.phone ?? null,
        resources: (v.sports ?? []).map((sport) => ({ sport })),
      })),
    );
    return {
      db: { venueOrg: { findUnique }, venue: { findMany } } as unknown as PrismaClient,
      findUnique,
      findMany,
    };
  }

  it('reads only the club’s ACTIVE venues with a public address, oldest first', async () => {
    const { db, findMany } = fakeDb({ status: 'ACTIVE', contactPhone: null }, [
      { publicSlug: 'a', sports: ['PADEL', 'PADEL', 'TENNIS'] },
    ]);
    const page = await loadClubPublicPage(db, 'alpha');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'ct1', status: 'ACTIVE', publicSlug: { not: null } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 50,
      }),
    );
    expect(page?.venues.map((v) => v.sports)).toEqual([['PADEL', 'TENNIS']]);
  });

  it.each(['SUSPENDED', 'CLOSED'])('a %s club is no page at all', async (status) => {
    const { db, findMany } = fakeDb({ status, contactPhone: '+359 2 000' }, [{ publicSlug: 'a' }]);
    await expect(loadClubPublicPage(db, 'alpha')).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('no such club: null', async () => {
    const { db } = fakeDb(null);
    await expect(loadClubPublicPage(db, 'nobody')).resolves.toBeNull();
  });

  it('the club’s phone, else its main venue’s', async () => {
    const own = fakeDb({ status: 'ACTIVE', contactPhone: '+359 2 111' }, [
      { publicSlug: 'a', phone: '+359 2 222' },
    ]);
    await expect(loadClubPublicPage(own.db, 'alpha')).resolves.toMatchObject({
      phone: '+359 2 111',
    });
    const venues = fakeDb({ status: 'ACTIVE', contactPhone: null }, [
      { publicSlug: 'a', phone: '+359 2 222' },
    ]);
    await expect(loadClubPublicPage(venues.db, 'alpha')).resolves.toMatchObject({
      phone: '+359 2 222',
    });
  });
});

describe('module-gated entries (#362)', () => {
  it('modules off by default: no Игри anywhere', () => {
    const hrefs = [
      ...playerTabs('player').map((t) => t.href),
      ...playerTopLinks('player').map((l) => l.href),
    ];
    expect(hrefs).not.toContain(MODULE_HREFS.openPlay);
  });

  it('openPlay on: Игри in the tabs and the top links, for a player only', () => {
    const on = { openPlay: true, messaging: false };
    expect(playerTabs('player', { modules: on }).map((t) => t.href)).toContain('/games');
    expect(playerTopLinks('player', on).map((l) => l.href)).toContain('/games');
    expect(
      playerTabs('club', { modules: on, adminHref: '/t/x/admin/calendar' }),
    ).not.toContainEqual(expect.objectContaining({ href: '/games' }));
    expect(playerTabs('signed-out', { modules: on }).map((t) => t.href)).not.toContain('/games');
  });
});
