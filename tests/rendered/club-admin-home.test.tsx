import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import ClubAdminHomePage from '@/app/(app)/t/[slug]/admin/(home)/page';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Role } from '@prisma/client';
import { getPermissionsForRole } from '@/lib/permissions';
import type { ResourceNouns } from '@/lib/sports/resource-kinds';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * THE CLUB ADMIN'S HOME (#362, owner 2026-10-08: the admin buttons, in the
 * same places as upstream's).
 *
 * What the sidebar foot's gear opens: upstream's admin page in playerz's
 * terms. The heading, the theme row beside it (`#admin-theme-toggle`, as
 * upstream's admin page has it), and a button for every admin page the role
 * opens, under the sidebar's own section titles. It was a redirect to the
 * first such page (audit C10); it is still never a 404 for a member with an
 * admin page, and never offers a page the role cannot open.
 */

class Refused extends Error {
  constructor(
    readonly how: 'notFound' | 'redirect',
    readonly to?: string,
  ) {
    super(`${how} ${to ?? ''}`);
  }
}
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  usePathname: () => '/t/sofia-padel/admin',
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
  notFound: () => {
    throw new Refused('notFound');
  },
  redirect: (to: string) => {
    throw new Refused('redirect', to);
  },
}));

const resolveTenantPageContext = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  resolveTenantPageContext: (slug: string) => resolveTenantPageContext(slug),
}));

const clubResourceNouns = jest.fn<Promise<ResourceNouns>, [string]>();
jest.mock('@/app-layer/usecases/club-nouns', () => ({
  clubResourceNouns: (tenantId: string) => clubResourceNouns(tenantId),
}));

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => {
    const value = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], bg);
    return typeof value === 'string' ? value : `${ns}.${key}`;
  },
}));

const SLUG = 'sofia-padel';
const n = bg.common.nav;
const member = (role: Role) => ({
  kind: 'ok',
  ctx: {
    userId: 'u1',
    tenantId: 'csofia',
    tenantSlug: SLUG,
    tenantName: 'Sofia Padel',
    role,
    permissions: getPermissionsForRole(role),
  },
});

async function renderHome() {
  const tree = await resolveServerTree(
    await ClubAdminHomePage({ params: Promise.resolve({ slug: SLUG }) }),
  );
  return render(withIntl(<TooltipProvider>{tree as ReactElement}</TooltipProvider>));
}

/** Each section: its eyebrow (or none), and its buttons as [label, href]. */
function groups() {
  return Array.from(document.body.querySelectorAll('section section'), (s) => ({
    title: s.getAttribute('aria-label'),
    pages: within(s as HTMLElement)
      .getAllByRole('link')
      .map((l) => [l.textContent?.trim(), l.getAttribute('href')]),
  }));
}

beforeEach(() => {
  resolveTenantPageContext.mockReset();
  clubResourceNouns.mockReset();
  clubResourceNouns.mockResolvedValue('court');
});

describe('the club admin’s home', () => {
  it('the heading, and the theme row beside it, as upstream’s admin page has it', async () => {
    resolveTenantPageContext.mockResolvedValue(member('OWNER'));
    await renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(bg.admin.home.title);
    const theme = document.getElementById('admin-theme-section')!;
    expect(theme).toHaveTextContent(bg.common.theme);
    expect(within(theme).getByRole('button')).toHaveAttribute('id', 'admin-theme-toggle');
  });

  it('OWNER: every admin page, under the sidebar’s own section titles', async () => {
    resolveTenantPageContext.mockResolvedValue(member('OWNER'));
    await renderHome();
    expect(groups()).toEqual([
      { title: null, pages: [[n.calendar, `/t/${SLUG}/admin/calendar`]] },
      {
        title: n.sectionVenue,
        pages: [
          [n.courts, `/t/${SLUG}/admin/courts`],
          [n.pricing, `/t/${SLUG}/admin/pricing`],
          [n.photos, `/t/${SLUG}/admin/photos`],
        ],
      },
      {
        title: n.sectionPeople,
        pages: [
          [n.players, `/t/${SLUG}/admin/players`],
          [n.staff, `/t/${SLUG}/admin/staff`],
        ],
      },
      { title: n.sectionFinance, pages: [[n.reports, `/t/${SLUG}/admin/reports`]] },
    ]);
  });

  it('STAFF: only the pages the role opens', async () => {
    resolveTenantPageContext.mockResolvedValue(member('STAFF'));
    await renderHome();
    expect(groups().flatMap((g) => g.pages)).toEqual([
      [n.calendar, `/t/${SLUG}/admin/calendar`],
      [n.players, `/t/${SLUG}/admin/players`],
    ]);
  });

  it('a karting club: its courts screen is "Писти" here too', async () => {
    resolveTenantPageContext.mockResolvedValue(member('OWNER'));
    clubResourceNouns.mockResolvedValue('track');
    await renderHome();
    expect(screen.getByRole('link', { name: n.track.courts })).toHaveAttribute(
      'href',
      `/t/${SLUG}/admin/courts`,
    );
    expect(clubResourceNouns).toHaveBeenCalledWith('csofia');
  });

  it('a member with no admin page, and a stranger, get the 404; a visitor signs in', async () => {
    resolveTenantPageContext.mockResolvedValue(member('PLAYER'));
    await expect(
      ClubAdminHomePage({ params: Promise.resolve({ slug: SLUG }) }),
    ).rejects.toMatchObject({ how: 'notFound' });

    resolveTenantPageContext.mockResolvedValue({ kind: 'not-a-member' });
    await expect(
      ClubAdminHomePage({ params: Promise.resolve({ slug: SLUG }) }),
    ).rejects.toMatchObject({ how: 'notFound' });

    resolveTenantPageContext.mockResolvedValue({ kind: 'unauthenticated' });
    await expect(
      ClubAdminHomePage({ params: Promise.resolve({ slug: SLUG }) }),
    ).rejects.toMatchObject({
      how: 'redirect',
      to: `/login?next=${encodeURIComponent(`/t/${SLUG}/admin`)}`,
    });
  });
});
