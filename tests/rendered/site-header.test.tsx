import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { SiteHeader } from '@/components/layout/SiteHeader';
import type { ChromeModules } from '@/components/layout/nav-items';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HOME, PLAYER_HOME, type LandingDecision } from '@/lib/auth/landing';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * SIGNING IN HAS TO BE VISIBLE, AND EACH KIND SEES ITS OWN WAY ON (#362).
 *
 * Before this header, the homepage read no session at all: a successful Google
 * round trip returned you to a page identical to the one you left. It was
 * reported twice as "I logged in and came back to the same screen" — the first
 * time a real defect (#223), the second time a sign-in that had worked
 * perfectly with nothing on screen to say so.
 *
 * Since #362 the header also carries each account kind's way on: a CLUB
 * account's "← Към админ" (#346), the bell, the messages icon behind its
 * module, and an account menu whose rows depend on the kind: Профил for all,
 * "Админ на клуба" for a club account, "Платформа" for a holder of a live
 * platform grant (#345). jsdom applies no media queries, so every width's
 * markup is here at once; the phone half is the tab bar's test and
 * tests/e2e/mobile/player-shell.spec.ts.
 */
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));

let pathname = '/venues';
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  usePathname: () => pathname,
}));

const signedInIdentity = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  signedInIdentity: () => signedInIdentity(),
}));

// Both reach Prisma, which has no business loading under jsdom; what they
// return is the input here.
const resolveLanding = jest.fn();
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: (...args: unknown[]) => resolveLanding(...args),
}));
const resolvePlatformAuthority = jest.fn();
jest.mock('@/lib/auth/platform-admin', () => ({
  resolvePlatformAuthority: (...args: unknown[]) => resolvePlatformAuthority(...args),
}));

// The flags are environment reads (src/lib/modules.ts); the test sets them.
let modules: ChromeModules = { openPlay: false, messaging: false };
jest.mock('@/lib/modules', () => ({ readModules: () => modules }));

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    // `as unknown as`: the catalogue is NESTED, so no flat record type
    // describes it. The namespace may be dotted (`common.nav`).
    const messages = (await import('../../messages/bg.json')).default as unknown;
    const scope = ns
      .split('.')
      .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], messages) as
      Record<string, unknown> | undefined;
    return (key: string) => {
      const value = scope?.[key];
      return typeof value === 'string' ? value : `${ns}.${key}`;
    };
  },
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

// The app mounts a TooltipProvider in Providers; the menu's theme row needs one.
// A fresh SWR cache per render: the bell (#367) reads /api/v1/me/notifications.
const renderHeader = async () =>
  render(
    withIntl(
      <SWRConfig value={{ provider: () => new Map() }}>
        <TooltipProvider>{await SiteHeader()}</TooltipProvider>
      </SWRConfig>,
    ),
  );

const IVO = { userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' };
const PLAYER: LandingDecision = { href: PLAYER_HOME, reason: 'player', club: null };
const COACH: LandingDecision = { href: PLAYER_HOME, reason: 'coach', club: null };
const CLUB: LandingDecision = {
  href: '/t/sofia-padel/admin/calendar',
  reason: 'club',
  club: { tenantId: 'csofia', tenantSlug: 'sofia-padel', tenantName: 'Sofia Padel' },
};
const NO_GRANT = { grantId: null, capabilities: [] };
const MODERATOR = { grantId: 'g1', capabilities: ['REVIEW_MODERATE'] };

const n = bg.common.nav;
const SIGN_IN = bg.login.title;
const accountMenu = (name: string) => bg.nav.accountMenuFor.replace('{name}', name);
const topNav = () => screen.getByRole('navigation', { name: bg.common.ui.mainNav });

/** Open the avatar's menu and list its rows, as the person reads them. */
function openMenu(name = 'Ivo') {
  fireEvent.click(screen.getByRole('button', { name: accountMenu(name) }));
  const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
  const rows = [...within(menu).queryAllByRole('link'), ...within(menu).queryAllByRole('button')]
    .filter((el) => el.closest('[data-testid="user-menu-theme-row"]') === null)
    .map((el) => [el.textContent, el.getAttribute('href')]);
  return { menu, rows };
}

beforeEach(() => {
  // The bell reads its page on mount; an empty one unless a test says otherwise.
  installFakeFetch(() => ok({ items: [], nextCursor: null, unreadCount: 0 }));
  pathname = '/venues';
  modules = { openPlay: false, messaging: false };
  desktopViewport();
  signedInIdentity.mockReset();
  resolveLanding.mockReset();
  resolveLanding.mockResolvedValue(PLAYER);
  resolvePlatformAuthority.mockReset();
  resolvePlatformAuthority.mockResolvedValue(NO_GRANT);
});

describe('SiteHeader — signed out', () => {
  it('offers sign-in and Играй, and no account, bell or admin', async () => {
    signedInIdentity.mockResolvedValue(null);
    await renderHeader();

    expect(screen.getByRole('link', { name: SIGN_IN })).toHaveAttribute('href', '/login');
    expect(within(topNav()).getByRole('link', { name: n.play })).toHaveAttribute('href', '/venues');
    // "Резервации" to a stranger is a link to a redirect.
    expect(screen.queryByRole('link', { name: n.bookings })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Меню на акаунта/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: n.notifications })).not.toBeInTheDocument();
    expect(screen.queryByTestId('site-header-admin')).not.toBeInTheDocument();
    // …and a stranger has no account to read, so nothing asks.
    expect(resolveLanding).not.toHaveBeenCalled();
    expect(resolvePlatformAuthority).not.toHaveBeenCalled();
  });

  it('does not link /login to itself (#319)', async () => {
    signedInIdentity.mockResolvedValue(null);
    pathname = '/login';
    await renderHeader();

    expect(screen.queryByRole('link', { name: SIGN_IN })).not.toBeInTheDocument();
    expect(within(topNav()).getByRole('link', { name: n.play })).toBeInTheDocument();
  });

  it('keeps the wordmark charcoal, linking home (owner decision)', async () => {
    signedInIdentity.mockResolvedValue(null);
    await renderHeader();

    const mark = screen.getByRole('link', { name: bg.common.appName });
    expect(mark).toHaveAttribute('href', '/');
    expect(mark).toHaveClass('text-content-emphasis');
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });
});

describe('SiteHeader — PLAYER', () => {
  it('Играй and Резервации, the bell, an account menu that names them, no admin', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    const nav = topNav();
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual(['/venues', '/me/bookings']);
    expect(screen.getByRole('button', { name: n.notifications })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: accountMenu('Ivo') })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-admin')).not.toBeInTheDocument();
    // No sign-in link while signed in — offering one implies it did not work.
    expect(screen.queryByRole('link', { name: SIGN_IN })).not.toBeInTheDocument();
    expect(resolveLanding).toHaveBeenCalledWith('u1');
  });

  it('menu: Профил, then Изход; no admin, no platform, no language row', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    const { menu, rows } = openMenu();
    expect(rows).toEqual([
      [n.profile, '/me/profile'],
      [bg.common.signOut, null],
    ]);
    // Theme stays in the menu (built in); language lives on the profile page.
    expect(within(menu).getByTestId('user-menu-theme-row')).toBeInTheDocument();
    expect(within(menu).queryByTestId('user-menu-language-row')).not.toBeInTheDocument();
  });

  it('names the account by its email when the provider gave no name', async () => {
    // An OAuth profile with no name is ordinary, and a blank trigger reads as broken.
    signedInIdentity.mockResolvedValue({ ...IVO, name: null });
    await renderHeader();

    expect(screen.getByRole('button', { name: accountMenu('ivo@example.bg') })).toBeInTheDocument();
  });
});

describe('SiteHeader — COACH', () => {
  it('a player’s links and menu: Профил, Изход; no admin', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(COACH);
    await renderHeader();

    expect(within(topNav()).getByRole('link', { name: n.bookings })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-admin')).not.toBeInTheDocument();
    expect(openMenu().rows).toEqual([
      [n.profile, '/me/profile'],
      [bg.common.signOut, null],
    ]);
  });
});

describe('SiteHeader — CLUB (owner or staff)', () => {
  it('"← Към админ" as a primary button to its admin, at every width (#346)', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(CLUB);
    await renderHeader();

    const admin = screen.getByTestId('site-header-admin');
    expect(admin).toHaveAttribute('href', '/t/sofia-padel/admin/calendar');
    expect(admin).toHaveTextContent(n.backToAdmin);
    // The vendored primary button's own recipe, not text styled as a link.
    expect(admin.className).toMatch(/text-content-inverted/);
    expect(admin.closest('.hidden')).toBeNull();
    // A club account cannot book: no Резервации.
    expect(screen.queryByRole('link', { name: n.bookings })).not.toBeInTheDocument();
    expect(within(topNav()).getByRole('link', { name: n.play })).toBeInTheDocument();
    // One account, one kind: no switcher, no picker.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('menu: Админ на клуба, Профил, Изход', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(CLUB);
    await renderHeader();

    expect(openMenu().rows).toEqual([
      [n.clubAdmin, '/t/sofia-padel/admin/calendar'],
      [n.profile, '/me/profile'],
      [bg.common.signOut, null],
    ]);
  });

  it('club-unavailable: no admin button and no admin row, still a way out', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue({ href: HOME, reason: 'club-unavailable', club: null });
    await renderHeader();

    expect(screen.queryByTestId('site-header-admin')).not.toBeInTheDocument();
    expect(openMenu().rows).toEqual([
      [n.profile, '/me/profile'],
      [bg.common.signOut, null],
    ]);
  });
});

describe('SiteHeader — moderator (a live platform grant, #345)', () => {
  it('menu: Профил, Платформа, Изход, from the same grant read the platform uses', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolvePlatformAuthority.mockResolvedValue(MODERATOR);
    await renderHeader();

    expect(openMenu().rows).toEqual([
      [n.profile, '/me/profile'],
      [n.platform, '/platform'],
      [bg.common.signOut, null],
    ]);
    expect(resolvePlatformAuthority).toHaveBeenCalledWith('u1');
  });

  it('a lapsed grant (no capabilities) shows no Платформа', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolvePlatformAuthority.mockResolvedValue(NO_GRANT);
    await renderHeader();

    expect(openMenu().rows.map(([label]) => label)).not.toContain(n.platform);
  });
});

describe('SiteHeader — modules hide what has not shipped', () => {
  it('modules off: no messages icon, no Игри', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    expect(screen.queryByRole('link', { name: n.messages })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: n.games })).not.toBeInTheDocument();
  });

  it('modules.messaging on: the messages icon, before the bell', async () => {
    modules = { openPlay: false, messaging: true };
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    const messages = screen.getByRole('link', { name: n.messages });
    expect(messages).toHaveAttribute('href', '/messages');
    expect(
      messages.compareDocumentPosition(screen.getByRole('button', { name: n.notifications })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('modules.openPlay on: Игри between Играй and Резервации', async () => {
    modules = { openPlay: true, messaging: false };
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    expect(
      within(topNav())
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual(['/venues', '/games', '/me/bookings']);
  });
});

describe('SiteHeader — the bell (#367)', () => {
  it('reads the bell as the signed-in viewer, and with nothing unread shows no count', async () => {
    const calls = installFakeFetch(() => ok({ items: [], nextCursor: null, unreadCount: 0 }));
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    const bell = screen.getByRole('button', { name: n.notifications });
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe('/api/v1/me/notifications?limit=20');
    expect(calls[0]!.headers['x-playerz-viewer']).toBe('u1');
    expect(bell.textContent).toBe('');

    fireEvent.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('notifications-empty')).toHaveTextContent(
      n.notificationsEmpty,
    );
  });
});

describe('SiteHeader — a failed read does not break the page (#319)', () => {
  // It renders above /login's error boundary: a throw here took sign-in down.
  it('identity unreadable: the signed-out header', async () => {
    signedInIdentity.mockRejectedValue(new Error('session store down'));
    await renderHeader();

    expect(screen.getByRole('link', { name: SIGN_IN })).toHaveAttribute('href', '/login');
    expect(resolveLanding).not.toHaveBeenCalled();
  });

  it('landing unreadable: a player’s links and no admin button', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockRejectedValue(new Error('database down'));
    await renderHeader();

    expect(within(topNav()).getByRole('link', { name: n.bookings })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-admin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: accountMenu('Ivo') })).toBeInTheDocument();
  });
});
