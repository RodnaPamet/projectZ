import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { ClubAdminShell } from '@/components/layout/club-admin-shell';
import { resolveClubTabs } from '@/components/layout/club-admin-tab-bar';
import {
  clubAdminNav,
  platformItemAllowed,
  platformNav,
  toShellSections,
  visibleSections,
  type ShellAccount,
} from '@/components/layout/nav-items';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Role } from '@prisma/client';
import { getPermissionsForRole } from '@/lib/permissions';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

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

// The account menu's language row writes the user record first (#362).
const persistMyLocale = jest.fn();
jest.mock('@/lib/i18n/persist-my-locale', () => ({
  persistMyLocale: (...a: unknown[]) => persistMyLocale(...a),
}));

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
/** `common.nav`, as next-intl reads it: a dotted key is a nested one (`track.courts`). */
const t = (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], n);
  return typeof value === 'string' ? value : `common.nav.${key}`;
};

const roleSections = (role: Role) =>
  toShellSections(
    visibleSections(clubAdminNav(SLUG), (i) => getPermissionsForRole(role).includes(i.requires)),
    t,
  );

const ACCOUNT: ShellAccount = {
  identity: { name: 'Mira', context: 'Sofia Padel', role: bg.admin.staff.role.OWNER },
  admin: { href: `/t/${SLUG}/admin`, label: n.admin },
  publicSite: { href: '/venues', label: n.publicPage },
};

function renderClub(role: Role, account: ShellAccount = ACCOUNT) {
  return render(
    withIntl(
      <SWRConfig value={{ provider: () => new Map() }}>
        <KeyboardShortcutProvider>
          <TooltipProvider>
            <ClubAdminShell
              sections={roleSections(role)}
              homeHref={`/t/${SLUG}/admin`}
              contextName="Sofia Padel"
              user={{ userId: 'u-mira', name: 'Mira', email: 'mira@sofia.bg' }}
              account={account}
              bottomTabs
              fullBleedSegment="calendar"
            >
              <p>page</p>
            </ClubAdminShell>
          </TooltipProvider>
        </KeyboardShortcutProvider>
      </SWRConfig>,
    ),
  );
}

/** The desktop rail (the drawer is the other `complementary`-less copy). */
const rail = () => screen.getByRole('complementary');

const bar = () => screen.getByRole('navigation', { name: n.tabBar });
const barTabs = () =>
  within(bar())
    .getAllByRole('link')
    .map((l) => [l.textContent, l.getAttribute('href')]);

beforeEach(() => {
  pathname = `/t/${SLUG}/admin/calendar`;
  desktopViewport();
  // The rail's collapse is persisted (`playerz:sidebar-collapsed`); each test
  // starts expanded.
  window.localStorage.clear();
  signOut.mockReset();
  persistMyLocale.mockReset();
  persistMyLocale.mockResolvedValue(undefined);
  installFakeFetch(() => ok({ items: [], nextCursor: null, unreadCount: 0 }));
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

  it('the drawer keeps the long tail, the way out, and the sidebar’s foot', () => {
    renderClub('OWNER');
    fireEvent.click(within(bar()).getByRole('button', { name: n.more }));
    const drawer = screen.getByRole('dialog', { name: n.menu });

    // The long tail: pricing and staff are not tabs, so the drawer has them.
    expect(within(drawer).getByRole('link', { name: n.pricing })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: n.staff })).toBeInTheDocument();

    // The public page, which the phone's top bar has no room for.
    const way = within(drawer).getByTestId('drawer-account');
    expect(within(way).getByRole('link', { name: n.publicPage })).toHaveAttribute(
      'href',
      '/venues',
    );

    // The same foot as the rail: who, the gear, Изход. The gear's id is the
    // rail's alone, so the open drawer does not double it.
    const foot = within(drawer).getByTestId('sidebar-account');
    expect(within(foot).getByTestId('sidebar-identity')).toHaveTextContent(
      ['Mira', 'Sofia Padel', bg.admin.staff.role.OWNER].join(''),
    );
    const gear = within(foot).getByRole('link', { name: n.admin });
    expect(gear).toHaveAttribute('href', `/t/${SLUG}/admin`);
    expect(gear).not.toHaveAttribute('id');
    fireEvent.click(within(foot).getByRole('button', { name: bg.common.signOut }));
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

describe('ShellTopBar — the way out (#347) and the account menu', () => {
  it('wordmark to the public home; the club’s name back to its admin; the public page from sm', () => {
    renderClub('OWNER');
    // Играй: where `/` sends anybody signed in (#362), linked directly.
    expect(screen.getByTestId('shell-wordmark')).toHaveAttribute('href', '/venues');
    expect(screen.getByTestId('shell-context-name')).toHaveAttribute('href', `/t/${SLUG}/admin`);
    const pub = screen.getByTestId('shell-public-link');
    expect(pub).toHaveAttribute('href', '/venues');
    expect(pub).toHaveTextContent(n.publicPage);
    expect(pub).toHaveClass('hidden', 'sm:inline-flex');
  });

  it('the bell, then the menu: the name, Тема, Език, Профил, Изход (owner, 2026-10-08)', () => {
    renderClub('OWNER');
    // Upstream's `TopChrome` order: the bell, then the account menu.
    const bell = screen.getByRole('button', { name: n.notifications });
    const trigger = screen.getByTestId('top-chrome-user-menu');
    expect(bell.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
    expect(within(menu).getByTestId('user-menu-display-name')).toHaveTextContent('Mira');
    expect(within(menu).getByTestId('user-menu-display-email')).toHaveTextContent('mira@sofia.bg');
    expect(within(menu).getByTestId('user-menu-theme-row')).toHaveTextContent(bg.common.theme);
    expect(within(menu).getByTestId('user-menu-language-row')).toHaveTextContent(
      bg.common.language,
    );
    // Upstream's own rows: `menuitem`s, the account's page then sign-out.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((l) => [l.textContent, l.getAttribute('href')]),
    ).toEqual([
      [n.profile, '/me/profile'],
      [bg.common.signOut, null],
    ]);
  });

  it('the language row writes the record first (`persistMyLocale`)', async () => {
    renderClub('OWNER');
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
    const row = screen.getByTestId('user-menu-language-row');
    await act(async () => {
      fireEvent.click(within(row).getByRole('radio', { name: 'English' }));
    });
    expect(persistMyLocale).toHaveBeenCalledWith('en');
  });
});

describe('The sidebar’s foot (owner, 2026-10-08: upstream’s user block)', () => {
  it('the name, the club and the role; the gear to the club admin; Изход', () => {
    renderClub('OWNER');
    const foot = within(rail()).getByTestId('sidebar-account');
    const lines = within(foot).getByTestId('sidebar-identity').querySelectorAll('p');
    expect(Array.from(lines, (l) => [l.textContent, l.className.includes('muted')])).toEqual([
      ['Mira', false],
      ['Sofia Padel', true],
      [bg.admin.staff.role.OWNER, true],
    ]);
    const gear = within(foot).getByRole('link', { name: n.admin });
    expect(gear).toHaveAttribute('href', `/t/${SLUG}/admin`);
    expect(gear).toHaveAttribute('id', 'admin-icon-link-desktop');
    expect(gear).toHaveClass('icon-btn', 'icon-btn-sm');
    const out = within(foot).getByRole('button', { name: bg.common.signOut });
    expect(out).toHaveClass('icon-btn', 'icon-btn-sm');
    fireEvent.click(out);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });

  it('no gear where the account has no admin to open', () => {
    renderClub('OWNER', { ...ACCOUNT, admin: null });
    const foot = within(rail()).getByTestId('sidebar-account');
    expect(within(foot).queryByTestId('nav-admin-icon')).not.toBeInTheDocument();
    expect(within(foot).getByRole('button', { name: bg.common.signOut })).toBeInTheDocument();
  });

  it('collapsed: the identity goes, and the two icons stack centred', () => {
    renderClub('OWNER');
    fireEvent.click(within(rail()).getByTestId('sidebar-collapse-toggle'));
    const foot = within(rail()).getByTestId('sidebar-account');
    expect(within(foot).queryByTestId('sidebar-identity')).not.toBeInTheDocument();
    const icons = within(foot).getByTestId('nav-logout').parentElement!;
    expect(icons).toHaveClass('flex-col', 'items-center');
    expect(within(icons).getByTestId('nav-admin-icon')).toBeInTheDocument();
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
              user={{ userId: 'u-mod', name: 'Mod', email: 'mod@playerz.bg' }}
              account={{
                identity: { name: 'Mod', context: bg.admin.staff.role.PLAYER, role: n.platform },
                admin: { href: '/platform', label: n.platform },
                publicSite: { href: '/venues', label: n.toSite },
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
    expect(screen.getByTestId('shell-public-link')).toHaveAttribute('href', '/venues');
    expect(screen.getByTestId('shell-context-name')).toHaveAttribute('href', '/platform');
  });

  it('its menu is every shell’s: Тема, Език, Профил, Изход', () => {
    pathname = '/platform/moderation';
    renderPlatform();
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
    const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
    expect(within(menu).getByTestId('user-menu-theme-row')).toBeInTheDocument();
    expect(within(menu).getByTestId('user-menu-language-row')).toBeInTheDocument();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((l) => [l.textContent, l.getAttribute('href')]),
    ).toEqual([
      [n.profile, '/me/profile'],
      [bg.common.signOut, null],
    ]);
  });

  it('its foot: the grant on the third line, the gear to the platform', () => {
    pathname = '/platform/moderation';
    renderPlatform();
    const foot = within(screen.getByRole('complementary')).getByTestId('sidebar-account');
    expect(within(foot).getByTestId('sidebar-identity')).toHaveTextContent(
      ['Mod', bg.admin.staff.role.PLAYER, n.platform].join(''),
    );
    expect(within(foot).getByRole('link', { name: n.platform })).toHaveAttribute(
      'href',
      '/platform',
    );
  });
});
