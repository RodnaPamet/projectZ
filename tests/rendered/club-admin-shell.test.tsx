import { fireEvent, render, screen, within } from '@testing-library/react';

import type { AccountLinks } from '@/components/layout/account-links';
import { ClubAdminShell } from '@/components/layout/club-admin-shell';
import { resolveClubTabs } from '@/components/layout/club-admin-tab-bar';
import {
  clubAdminNav,
  platformItemAllowed,
  platformNav,
  toShellSections,
  visibleSections,
} from '@/components/layout/nav-items';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Role } from '@prisma/client';
import { getPermissionsForRole } from '@/lib/permissions';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';

/**
 * The club admin shell per role, and the platform shell (#362, #345, #347).
 *
 * The sections are built the way the admin layout builds them: `clubAdminNav`
 * filtered by the role's permissions, translated. So "the bar never shows a
 * page the role cannot open" is asserted against the same filter the server
 * applies, for every club role.
 *
 *   OWNER / MANAGER   Календар · Кортове · Играчи · Още
 *   STAFF             Календар · Играчи · Още
 *   COACH             Играчи · Още
 *
 * jsdom applies no media queries: the bar's `md:hidden` and the top bar's
 * `sm:inline-flex` are classes here, measured in tests/e2e/mobile/admin-shell.spec.ts.
 */
const signOut = jest.fn();
jest.mock('next-auth/react', () => ({ signOut: (...a: unknown[]) => signOut(...a) }));

let pathname = '/t/sofia-padel/admin/calendar';
jest.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSelectedLayoutSegment: () => pathname.split('/')[4] ?? null,
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
}));

/** Wide enough that the vendored Popover is a dropdown jsdom can open. */
function desktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1024px') || query.includes('640px'),
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

const SLUG = 'sofia-padel';
const n = bg.common.nav;
const t = (key: string) => (n as Record<string, string>)[key] ?? `common.nav.${key}`;

const roleSections = (role: Role) =>
  toShellSections(
    visibleSections(clubAdminNav(SLUG), (i) => getPermissionsForRole(role).includes(i.requires)),
    t,
  );

const ACCOUNT: AccountLinks = {
  profileHref: '/me/profile',
  clubAdmin: null,
  platformHref: null,
  publicSite: { href: '/venues', label: n.publicPage },
};

function renderClub(role: Role, account: AccountLinks = ACCOUNT) {
  return render(
    withIntl(
      <KeyboardShortcutProvider>
        <TooltipProvider>
          <ClubAdminShell
            sections={roleSections(role)}
            homeHref={`/t/${SLUG}/admin`}
            contextName="Sofia Padel"
            user={{ name: 'Mira', email: 'mira@sofia.bg' }}
            account={account}
            bottomTabs
            fullBleedSegment="calendar"
          >
            <p>page</p>
          </ClubAdminShell>
        </TooltipProvider>
      </KeyboardShortcutProvider>,
    ),
  );
}

const bar = () => screen.getByRole('navigation', { name: n.tabBar });
const barTabs = () =>
  within(bar())
    .getAllByRole('link')
    .map((l) => [l.textContent, l.getAttribute('href')]);

beforeEach(() => {
  pathname = `/t/${SLUG}/admin/calendar`;
  desktopViewport();
  signOut.mockReset();
});

describe('ClubAdminTabBar — tabs per role, resolved from the sidebar’s own sections', () => {
  const admin = (page: string) => `/t/${SLUG}/admin/${page}`;

  it('OWNER: Календар, Кортове, Играчи, then Още', () => {
    renderClub('OWNER');
    expect(barTabs()).toEqual([
      [n.calendar, admin('calendar')],
      [n.courts, admin('courts')],
      [n.players, admin('players')],
    ]);
    expect(within(bar()).getByRole('button', { name: n.more })).toBeInTheDocument();
  });

  it('MANAGER: the owner’s three tabs', () => {
    renderClub('MANAGER');
    expect(barTabs().map(([, href]) => href)).toEqual([
      admin('calendar'),
      admin('courts'),
      admin('players'),
    ]);
  });

  it('STAFF: Календар and Играчи; no Кортове, which staff cannot open', () => {
    renderClub('STAFF');
    expect(barTabs()).toEqual([
      [n.calendar, admin('calendar')],
      [n.players, admin('players')],
    ]);
  });

  it('COACH: Играчи only (players.view is all it holds)', () => {
    renderClub('COACH');
    expect(barTabs()).toEqual([[n.players, admin('players')]]);
  });

  it.each(['OWNER', 'MANAGER', 'STAFF', 'COACH', 'PLAYER'] as const)(
    '%s: the bar never offers a page the role cannot open',
    (role) => {
      const allowed = new Set(
        visibleSections(clubAdminNav(SLUG), (i) =>
          getPermissionsForRole(role).includes(i.requires),
        ).flatMap((s) => s.items.map((i) => i.href)),
      );
      for (const tab of resolveClubTabs(roleSections(role))) {
        expect({ role, href: tab.href, allowed: allowed.has(tab.href) }).toEqual({
          role,
          href: tab.href,
          allowed: true,
        });
      }
      // And the negative control: a role WITHOUT a page has no tab for it.
      const all = resolveClubTabs(roleSections('OWNER')).map((tab) => tab.href);
      for (const href of all) {
        if (!allowed.has(href)) {
          expect(resolveClubTabs(roleSections(role)).map((tab) => tab.href)).not.toContain(href);
        }
      }
    },
  );

  it('marks the current tab with aria-current and the accent bar', () => {
    pathname = `/t/${SLUG}/admin/players`;
    renderClub('OWNER');
    const players = within(bar()).getByRole('link', { name: n.players });
    expect(players).toHaveAttribute('aria-current', 'page');
    expect(players.querySelector('[data-tab-accent]')).not.toBeNull();
    expect(within(bar()).getByRole('link', { name: n.calendar })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('is md:hidden, every target 44 px, icons hidden, and clear of the home indicator', () => {
    renderClub('OWNER');
    expect(bar()).toHaveClass('md:hidden');
    expect(bar().className).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
    for (const el of [
      ...within(bar()).getAllByRole('link'),
      within(bar()).getByRole('button', { name: n.more }),
    ]) {
      expect(el).toHaveClass('min-h-11', 'min-w-11');
      expect(el.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});

describe('Още opens the drawer, and says so', () => {
  it('aria-expanded follows the drawer; the drawer is named "Меню"', () => {
    renderClub('OWNER');
    const more = within(bar()).getByRole('button', { name: n.more });
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(more);

    expect(more).toHaveAttribute('aria-expanded', 'true');
    const drawer = screen.getByRole('dialog', { name: n.menu });
    // The hamburger's instruction is no longer the panel's title.
    expect(within(drawer).queryByText(bg.nav.openNavigationMenu)).not.toBeInTheDocument();
  });

  it('the drawer keeps the long tail and ends in the account rows, Изход a real button', () => {
    renderClub('OWNER');
    fireEvent.click(within(bar()).getByRole('button', { name: n.more }));
    const drawer = screen.getByRole('dialog', { name: n.menu });

    // The long tail: pricing and staff are not tabs, so the drawer has them.
    expect(within(drawer).getByRole('link', { name: n.pricing })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: n.staff })).toBeInTheDocument();

    const account = within(drawer).getByTestId('drawer-account');
    expect(
      within(account)
        .getAllByRole('link')
        .map((l) => [l.textContent, l.getAttribute('href')]),
    ).toEqual([
      [n.publicPage, '/venues'],
      [n.profile, '/me/profile'],
    ]);
    const signOutRow = within(account).getByRole('button', { name: bg.common.signOut });
    fireEvent.click(signOutRow);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });

  it('a STAFF member’s drawer offers no page staff cannot open', () => {
    renderClub('STAFF');
    fireEvent.click(within(bar()).getByRole('button', { name: n.more }));
    const drawer = screen.getByRole('dialog', { name: n.menu });
    for (const hidden of [n.courts, n.pricing, n.staff]) {
      expect(within(drawer).queryByRole('link', { name: hidden })).not.toBeInTheDocument();
    }
  });
});

describe('AdminTopBar — the way out (#347) and the account menu', () => {
  it('wordmark to the public home; the club’s name back to its admin; the public page from sm', () => {
    renderClub('OWNER');
    expect(screen.getByTestId('admin-wordmark')).toHaveAttribute('href', '/');
    expect(screen.getByTestId('admin-context-name')).toHaveAttribute('href', `/t/${SLUG}/admin`);
    const pub = screen.getByTestId('admin-public-link');
    expect(pub).toHaveAttribute('href', '/venues');
    expect(pub).toHaveTextContent(n.publicPage);
    expect(pub).toHaveClass('hidden', 'sm:inline-flex');
  });

  it('menu: Публична страница, Профил, Изход; no language row', () => {
    renderClub('OWNER');
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
    const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((l) => [l.textContent, l.getAttribute('href')]),
    ).toEqual([
      [n.publicPage, '/venues'],
      [n.profile, '/me/profile'],
    ]);
    expect(within(menu).getByRole('button', { name: bg.common.signOut })).toBeInTheDocument();
    expect(within(menu).queryByTestId('user-menu-language-row')).not.toBeInTheDocument();
  });

  it('a club account that also moderates gets Платформа in the menu and the drawer', () => {
    renderClub('OWNER', { ...ACCOUNT, platformHref: '/platform' });
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
    const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
    expect(within(menu).getByRole('link', { name: n.platform })).toHaveAttribute(
      'href',
      '/platform',
    );
  });
});

describe('The platform shell (moderator, #345, #347)', () => {
  function renderPlatform() {
    const sections = toShellSections(
      visibleSections(platformNav(), (i) => platformItemAllowed(i, ['REVIEW_MODERATE'])),
      t,
    );
    return render(
      withIntl(
        <KeyboardShortcutProvider>
          <TooltipProvider>
            <ClubAdminShell
              sections={sections}
              homeHref="/platform"
              contextName={bg.platform.name}
              user={{ name: 'Mod', email: 'mod@playerz.bg' }}
              account={{
                profileHref: '/me/profile',
                clubAdmin: null,
                platformHref: null,
                publicSite: { href: '/', label: n.toSite },
              }}
            >
              <p>queue</p>
            </ClubAdminShell>
          </TooltipProvider>
        </KeyboardShortcutProvider>,
      ),
    );
  }

  it('has no bottom bar, and an exit to the public site', () => {
    pathname = '/platform/moderation';
    renderPlatform();
    expect(screen.queryByRole('navigation', { name: n.tabBar })).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-public-link')).toHaveAttribute('href', '/');
    expect(screen.getByTestId('admin-context-name')).toHaveAttribute('href', '/platform');
  });

  it('its menu: Към сайта, Профил, Изход', () => {
    pathname = '/platform/moderation';
    renderPlatform();
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
    const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((l) => [l.textContent, l.getAttribute('href')]),
    ).toEqual([
      [n.toSite, '/'],
      [n.profile, '/me/profile'],
    ]);
  });
});
