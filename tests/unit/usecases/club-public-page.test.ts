import type { PrismaClient } from '@prisma/client';

import { clubFirstVenuePublicSlug } from '@/app-layer/usecases/club-public-page';
import {
  clubPublicHref,
  MODULE_HREFS,
  playerTabs,
  playerTopLinks,
} from '@/components/layout/nav-items';

/**
 * Where "Публична страница ↗" leads from a club's admin (#347, #362), and the
 * module-gated entries of the player chrome, as data.
 */
describe('clubPublicHref', () => {
  it('a club with a live venue: that venue’s page (#355)', () => {
    expect(clubPublicHref('padel-lozenets')).toBe('/venues/padel-lozenets');
  });

  it('escapes the slug, so a stored value cannot add a path segment', () => {
    expect(clubPublicHref('a/b')).toBe('/venues/a%2Fb');
  });

  it('a club with no live venue yet: the venue list', () => {
    expect(clubPublicHref(null)).toBe('/venues');
  });
});

describe('clubFirstVenuePublicSlug', () => {
  function fakeDb(row: { publicSlug: string | null } | null) {
    const findFirst = jest.fn().mockResolvedValue(row);
    return { db: { venue: { findFirst } } as unknown as PrismaClient, findFirst };
  }

  it('asks for the club’s oldest ACTIVE venue that has a public address', async () => {
    const { db, findFirst } = fakeDb({ publicSlug: 'padel-lozenets' });
    await expect(clubFirstVenuePublicSlug(db, 'ct1')).resolves.toBe('padel-lozenets');
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'ct1', status: 'ACTIVE', publicSlug: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { publicSlug: true },
    });
  });

  it('no such venue: null, so the caller falls back to the list', async () => {
    const { db } = fakeDb(null);
    await expect(clubFirstVenuePublicSlug(db, 'ct1')).resolves.toBeNull();
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
