import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';

import { ClubAdminShell } from '@/components/layout/club-admin-shell';
import { clubAdminCrumbs, platformCrumbs, playCrumbs } from '@/components/layout/crumbs';
import {
  clubAdminNav,
  platformItemAllowed,
  platformNav,
  playerShellNav,
  toShellSections,
  visibleSections,
  type ShellAccount,
} from '@/components/layout/nav-items';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { PlayerShell } from '@/components/layout/player-shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * THE TOP BAR'S LEFT SLOT IS THE PAGE'S TRAIL (#362, owner 2026-10-08).
 *
 * Upstream's `TopChrome`: the breadcrumbs from `md` (`useCurrentBreadcrumbs`
 * over the vendored `BreadcrumbsProvider`, drawn by the vendored
 * `Breadcrumbs`), a screen-reader sentinel while no page has pushed one, and
 * the brand mark below `md` only. The sidebar's header keeps the app's (or
 * the club's, or the platform's) name, so the name is never on screen twice.
 *
 * A page pushes its trail with the vendored `PageBreadcrumbs`, which also
 * draws it inline below `md`, as upstream's pages do. Each shell is rendered
 * here with a page that does, and one that does not.
 *
 * jsdom applies no media queries: `md:hidden` and `hidden md:inline-flex` are
 * classes here, and tests/e2e/*shell-breadcrumbs.spec.ts measures them.
 */

jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));
jest.mock('@/lib/i18n/persist-my-locale', () => ({ persistMyLocale: jest.fn() }));
let pathname = '/venues/sofia-padel-club';
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  usePathname: () => pathname,
  useSelectedLayoutSegment: () => null,
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
}));

const n = bg.common.nav;
/** `common.nav`, as next-intl reads it: a dotted key is a nested one. */
const t = (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], n);
  return typeof value === 'string' ? value : `common.nav.${key}`;
};
const USER = { userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' };
const SLUG = 'sofia-padel';

function frame(children: ReactNode) {
  return render(
    withIntl(
      <SWRConfig value={{ provider: () => new Map() }}>
        <KeyboardShortcutProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </KeyboardShortcutProvider>
      </SWRConfig>,
    ),
  );
}

const PLAYER_ACCOUNT: ShellAccount = {
  identity: { name: 'Ivo', context: bg.admin.staff.role.PLAYER, role: null },
  admin: null,
  publicSite: null,
};

function playerShell(page: ReactNode) {
  return frame(
    <PlayerShell
      sections={toShellSections(playerShellNav('player'), t)}
      contextName={bg.common.appName}
      user={USER}
      account={PLAYER_ACCOUNT}
      kind="player"
      modules={{ openPlay: false, messaging: false }}
    >
      {page}
    </PlayerShell>,
  );
}

function clubShell(page: ReactNode) {
  return frame(
    <ClubAdminShell
      sections={toShellSections(
        visibleSections(clubAdminNav(SLUG), (i) =>
          getPermissionsForRole('OWNER').includes(i.requires),
        ),
        t,
      )}
      homeHref={`/t/${SLUG}/admin`}
      contextName="Sofia Padel"
      user={USER}
      account={{
        identity: { name: 'Ivo', context: 'Sofia Padel', role: bg.admin.staff.role.OWNER },
        admin: { href: `/t/${SLUG}/admin`, label: n.admin },
        publicSite: { href: `/clubs/${SLUG}`, label: n.publicPage },
      }}
      bottomTabs
    >
      {page}
    </ClubAdminShell>,
  );
}

function platformShell(page: ReactNode) {
  return frame(
    <ClubAdminShell
      sections={toShellSections(
        visibleSections(platformNav(), (i) => platformItemAllowed(i, ['REVIEW_MODERATE'])),
        t,
      )}
      homeHref="/platform"
      contextName={bg.platform.name}
      user={USER}
      account={{
        identity: { name: 'Ivo', context: bg.admin.staff.role.PLAYER, role: n.platform },
        admin: { href: '/platform', label: n.platform },
        publicSite: { href: '/venues', label: n.toSite },
      }}
    >
      {page}
    </ClubAdminShell>,
  );
}

/** The trail in the top bar: [label, href or null] per crumb, and the current one. */
function topBarTrail() {
  const banner = screen.getByRole('banner');
  const trail = within(banner).getByTestId('top-chrome-breadcrumbs');
  return {
    trail,
    crumbs: within(trail)
      .getAllByRole('listitem')
      .map((li) => {
        const a = li.querySelector('a');
        return [li.textContent?.replace('/', '').trim(), a?.getAttribute('href') ?? null];
      }),
    current: trail.querySelector('[aria-current="page"]')?.textContent,
  };
}

/** The rail's header, the collapse control that names the app, the club or the platform. */
const sidebarHeader = () =>
  within(screen.getByRole('complementary')).getByTestId('sidebar-collapse-toggle');

beforeEach(() => {
  pathname = '/venues/sofia-padel-club';
  installFakeFetch(() => ok({ items: [], nextCursor: null, unreadCount: 0 }));
  window.localStorage.clear();
});

describe('the player shell', () => {
  it('a venue page: Играй / the venue in the top bar, from md', () => {
    playerShell(<PageBreadcrumbs items={playCrumbs(t, 'Sofia Padel Club')} />);

    const { trail, crumbs, current } = topBarTrail();
    expect(crumbs).toEqual([
      [n.play, '/venues'],
      ['Sofia Padel Club', null],
    ]);
    expect(current).toBe('Sofia Padel Club');
    // Named, as upstream names it, in the viewer's language.
    expect(trail).toHaveAttribute('aria-label', bg.common.ui.breadcrumb);
    // From md only: the slot is hidden below it.
    expect(trail.parentElement).toHaveClass('hidden', 'md:inline-flex');
  });

  it('the wordmark is the phone’s, and the sidebar keeps the name: never twice from md', () => {
    playerShell(<PageBreadcrumbs items={playCrumbs(t, 'Sofia Padel Club')} />);

    const wordmark = within(screen.getByRole('banner')).getByTestId('shell-wordmark');
    expect(wordmark).toHaveClass('md:hidden');
    expect(wordmark).toHaveAttribute('href', '/venues');
    expect(sidebarHeader()).toHaveTextContent(bg.common.appName);
  });

  it('the page draws the same trail inline for a phone, as upstream’s pages do', () => {
    playerShell(
      <main>
        <PageBreadcrumbs items={playCrumbs(t, 'Sofia Padel Club')} />
      </main>,
    );
    // The page's own copy sits outside the banner, and only below md.
    const inline = screen
      .getAllByTestId('breadcrumbs')
      .find((el) => !screen.getByRole('banner').contains(el))!;
    expect(inline.parentElement).toHaveClass('md:hidden');
    expect(within(inline).getByRole('link', { name: n.play })).toHaveAttribute('href', '/venues');
  });

  it('a one-crumb page (Играй) is drawn in the top bar only', () => {
    pathname = '/venues';
    playerShell(<PageBreadcrumbs items={playCrumbs(t)} className="hidden" />);
    // The one crumb is the page itself: drawn as the current page, not a link.
    expect(topBarTrail()).toMatchObject({ crumbs: [[n.play, null]], current: n.play });
    const inline = screen
      .getAllByTestId('breadcrumbs')
      .find((el) => !screen.getByRole('banner').contains(el))!;
    expect(inline.parentElement).toHaveClass('hidden');
  });

  it('a page that pushes nothing leaves the sentinel, so the bar keeps its height', () => {
    playerShell(<p>page</p>);
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByTestId('top-chrome-breadcrumbs')).not.toBeInTheDocument();
    expect(within(banner).getByText(bg.nav.noBreadcrumbs)).toHaveClass('sr-only');
  });

  it('the trail follows the page: a new page’s push replaces the old one', () => {
    const { rerender } = playerShell(<PageBreadcrumbs items={playCrumbs(t, 'Sofia Padel Club')} />);
    rerender(
      withIntl(
        <SWRConfig value={{ provider: () => new Map() }}>
          <KeyboardShortcutProvider>
            <TooltipProvider>
              <PlayerShell
                sections={toShellSections(playerShellNav('player'), t)}
                contextName={bg.common.appName}
                user={USER}
                account={PLAYER_ACCOUNT}
                kind="player"
                modules={{ openPlay: false, messaging: false }}
              >
                <PageBreadcrumbs items={playCrumbs(t, 'Plovdiv Tennis Center')} />
              </PlayerShell>
            </TooltipProvider>
          </KeyboardShortcutProvider>
        </SWRConfig>,
      ),
    );
    expect(topBarTrail().current).toBe('Plovdiv Tennis Center');
  });
});

describe('the club admin shell', () => {
  it('Администрация / Кортове, and the club’s name stays the sidebar’s', () => {
    pathname = `/t/${SLUG}/admin/courts`;
    clubShell(<PageBreadcrumbs items={clubAdminCrumbs(SLUG, t, 'courts')} />);

    expect(topBarTrail().crumbs).toEqual([
      [n.admin, `/t/${SLUG}/admin`],
      [n.courts, null],
    ]);
    expect(within(screen.getByRole('banner')).getByTestId('shell-wordmark')).toHaveClass(
      'md:hidden',
    );
    expect(sidebarHeader()).toHaveTextContent('Sofia Padel');
  });

  it('at a karting club the courts crumb is the sidebar’s word, "Писти"', () => {
    pathname = `/t/${SLUG}/admin/courts`;
    clubShell(<PageBreadcrumbs items={clubAdminCrumbs(SLUG, t, 'courts', 'track')} />);
    expect(topBarTrail().current).toBe(n.track.courts);
  });
});

describe('the platform shell', () => {
  it('Платформа / Модерация', () => {
    pathname = '/platform/moderation';
    platformShell(<PageBreadcrumbs items={platformCrumbs(t, 'moderation')} />);
    expect(topBarTrail().crumbs).toEqual([
      [n.platform, '/platform'],
      [n.moderation, null],
    ]);
    expect(sidebarHeader()).toHaveTextContent(bg.platform.name);
  });
});
