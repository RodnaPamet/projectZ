/**
 * @jest-environment node
 */
import type { ResourceNouns } from '@/lib/sports/resource-kinds';

import bg from '../../../messages/bg.json';

/**
 * THE COURTS SCREEN'S TAB TITLE SAYS WHAT THE CLUB PLAYS ON (P51, #362).
 *
 * Its heading has read "Писти" at a karting club since P51; the tab title and
 * the club nav's item said "Кортове" regardless. The title now takes the same
 * noun as the heading and the nav item (`clubResourceNouns`), read for the
 * club the URL names. A visitor the page refuses gets the plain title: the
 * page answers them with its 404, and their title names no club's resources.
 */

const resolveTenantPageContext = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  resolveTenantPageContext: (slug: string) => resolveTenantPageContext(slug),
}));

const clubResourceNouns = jest.fn<Promise<ResourceNouns>, [string]>();
jest.mock('@/app-layer/usecases/club-nouns', () => ({
  clubResourceNouns: (tenantId: string) => clubResourceNouns(tenantId),
}));

// Reach Prisma, which a title has no business loading here.
jest.mock('@/app-layer/usecases/courts', () => ({ loadCourtsScreen: jest.fn() }));
jest.mock('@/app-layer/repositories/court', () => ({
  COURT_LIST_LIMIT: 200,
  courtsWereTruncated: () => false,
}));
jest.mock('@/lib/db/rls-middleware', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app/(app)/t/[slug]/admin/courts/CourtsBoard', () => ({ CourtsBoard: () => null }));

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => {
    const value = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], bg);
    return typeof value === 'string' ? value : `${ns}.${key}`;
  },
}));

const OK = {
  kind: 'ok',
  ctx: {
    userId: 'u1',
    tenantId: 'ckarting0000000000000000',
    tenantSlug: 'sofia-karting',
    tenantName: 'Sofia Karting Ring',
    role: 'OWNER',
    permissions: ['courts.manage'],
  },
};

async function titleFor(slug: string) {
  const { generateMetadata } = await import('@/app/(app)/t/[slug]/admin/courts/page');
  return (await generateMetadata({ params: Promise.resolve({ slug }) })).title;
}

beforeEach(() => {
  resolveTenantPageContext.mockReset();
  clubResourceNouns.mockReset();
});

describe('the courts screen’s tab title', () => {
  it.each([
    ['court', bg.admin.courts.metaTitle],
    ['track', bg.admin.courts.track.metaTitle],
    ['mixed', bg.admin.courts.mixed.metaTitle],
  ] as const)('a club of %s reads "%s"', async (nouns, title) => {
    resolveTenantPageContext.mockResolvedValue(OK);
    clubResourceNouns.mockResolvedValue(nouns);

    expect(await titleFor('sofia-karting')).toBe(title);
    expect(resolveTenantPageContext).toHaveBeenCalledWith('sofia-karting');
    expect(clubResourceNouns).toHaveBeenCalledWith('ckarting0000000000000000');
  });

  it('is "Писти" at a karting club, the heading’s own word', () => {
    expect(bg.admin.courts.track.metaTitle).toBe('Писти');
    expect(bg.admin.courts.track.metaTitle).toBe(bg.admin.courts.track.title);
    expect(bg.admin.courts.mixed.metaTitle).toBe(bg.admin.courts.mixed.title);
  });

  it('a visitor the page refuses gets the plain title, and no club is read', async () => {
    resolveTenantPageContext.mockResolvedValue({ kind: 'not-a-member' });

    expect(await titleFor('someone-elses-club')).toBe(bg.admin.courts.metaTitle);
    expect(clubResourceNouns).not.toHaveBeenCalled();
  });
});
