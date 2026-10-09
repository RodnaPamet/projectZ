import { fireEvent, render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { LandingDecision } from '@/lib/auth/landing';
import { PlayerChrome } from '@/components/layout/player-chrome';
import type { ChromeModules } from '@/components/layout/nav-items';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * WHAT EACH ACCOUNT KIND'S FRAME OFFERS (#362, owner 2026-10-07).
 *
 * Signed in on a computer, the owner could not find the navigation: two text
 * links and an avatar in a top bar. "It should look like inflect UI, with the
 * navbar on the left." So `PlayerChrome` decides on the server which frame a
 * page wears, and this renders it for every kind, with the reads it makes
 * mocked to say who is asking:
 *
 *   signed out   the public header (Играй, Вход), the footer, the tab bar
 *   player       the AppShell: Играй · Резервации · Профил in the left rail
 *   coach        the same items, until the coach module ships its own
 *   moderator    a player's items, then "Платформа" with the pages the grant opens
 *   club         its club admin's sidebar, on a public page as in the admin
 *
 * Only allowed items, and the module flags hide Игри and Съобщения. jsdom
 * applies no media queries, so every width's markup is here at once: the
 * desktop rail, the phone bar, and (opened) the phone drawer. The browser half
 * is tests/e2e/player-shell.spec.ts and its mobile twin.
 */
const signOut = jest.fn();
jest.mock('next-auth/react', () => ({ signOut: (...a: unknown[]) => signOut(...a) }));
// The account menu's language row writes the user record first (#362).
jest.mock('@/lib/i18n/persist-my-locale', () => ({ persistMyLocale: jest.fn() }));

let pathname = '/venues';
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  usePathname: () => pathname,
  useSelectedLayoutSegment: () => null,
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
}));

const signedInIdentity = jest.fn();
const resolveTenantPageContext = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  signedInIdentity: () => signedInIdentity(),
  resolveTenantPageContext: (slug: string) => resolveTenantPageContext(slug),
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
// What the club plays on (P51): the one read that names its courts screen.
const clubResourceNouns = jest.fn();
jest.mock('@/app-layer/usecases/club-nouns', () => ({
  clubResourceNouns: (tenantId: string) => clubResourceNouns(tenantId),
}));

// The flags are environment reads (src/lib/modules.ts); the test sets them.
let modules: ChromeModules = { openPlay: false, messaging: false };
jest.mock('@/lib/modules', () => ({ readModules: () => modules }));

jest.mock('next-intl/server', () => ({
  // The signed-out chrome reads the language for its legal links (#370).
  getLocale: async () => 'bg',
  getTranslations: async (ns: string) => {
    // `as unknown as`: the catalogue is NESTED, so no flat record type
    // describes it. The namespace may be dotted (`common.nav`).
    const messages = (await import('../../messages/bg.json')).default as unknown;
    const scope = ns
      .split('.')
      .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], messages) as
      Record<string, unknown> | undefined;
    return (key: string, values?: Record<string, string | number>) => {
      // A dotted key is a nested one, as next-intl reads it (`track.courts`).
      const value = key
        .split('.')
        .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], scope);
      if (typeof value !== 'string') return `${ns}.${key}`;
      return Object.entries(values ?? {}).reduce(
        (s, [k, v]) => s.replace(`{${k}}`, String(v)),
        value,
      );
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

const n = bg.common.nav;
const IVO = { userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' };
const SLUG = 'sofia-padel';
const PLAYER: LandingDecision = { href: '/me/bookings', reason: 'player', club: null };
const COACH: LandingDecision = { href: '/me/bookings', reason: 'coach', club: null };
const CLUB: LandingDecision = {
  href: `/t/${SLUG}/admin/calendar`,
  reason: 'club',
  club: { tenantId: 'csofia', tenantSlug: SLUG, tenantName: 'Sofia Padel' },
};
const NO_GRANT = { grantId: null, capabilities: [] };
const MODERATOR = { grantId: 'g1', capabilities: ['REVIEW_MODERATE'] };
const EVERY_CAPABILITY = {
  grantId: 'g2',
  capabilities: [
    'TENANT_READ',
    'AUDIT_READ',
    'USER_READ',
    'TENANT_SUSPEND',
    'REVIEW_MODERATE',
    'CLUB_FEE_MANAGE',
    'CONTACT_READ',
  ],
};

const membership = (role: Role) => ({
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

async function renderChrome() {
  const tree = await resolveServerTree(
    await PlayerChrome({ footer: true, children: <p data-testid="the-page">page</p> }),
  );
  return render(
    withIntl(
      <SWRConfig value={{ provider: () => new Map() }}>
        <KeyboardShortcutProvider>
          <TooltipProvider>{tree}</TooltipProvider>
        </KeyboardShortcutProvider>
      </SWRConfig>,
    ),
  );
}

/** The desktop rail: the `<aside>` the vendored frame draws, and its nav. */
const rail = () => screen.getByRole('complementary');
const railNav = () => within(rail()).getByRole('navigation', { name: bg.common.ui.mainNav });
/** A row's [label, href]. Trimmed: a glyph can carry a text node of its own. */
const row = (l: HTMLElement) => [l.textContent?.trim(), l.getAttribute('href')];
const railLinks = () => within(railNav()).getAllByRole('link').map(row);
const bar = () => screen.getByRole('navigation', { name: n.tabBar });
const barTabs = () => within(bar()).getAllByRole('link').map(row);

/** Open the account menu and list its place rows (the theme row is the menu's own). */
function menuRows() {
  fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
  const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
  return {
    menu,
    // The place rows: upstream's `menuitem`s that are links.
    links: within(menu)
      .queryAllByRole('menuitem')
      .filter((m) => m.hasAttribute('href'))
      .map(row),
  };
}

/**
 * The rail's foot (owner, 2026-10-08): its identity lines, and its gear as
 * [label, href], or `null` where the account has none.
 */
function railFoot() {
  const foot = within(rail()).getByTestId('sidebar-account');
  const gear = within(foot).queryByTestId('nav-admin-icon');
  return {
    lines: Array.from(within(foot).getByTestId('sidebar-identity').querySelectorAll('p'), (p) =>
      p.textContent?.trim(),
    ),
    gear: gear ? [gear.getAttribute('aria-label'), gear.getAttribute('href')] : null,
    signOut: within(foot).getByRole('button', { name: bg.common.signOut }),
  };
}

/** Every shell's menu: the name, Тема, Език, then Профил and Изход (owner, 2026-10-08). */
function expectTheMenu() {
  const { menu, links } = menuRows();
  expect(within(menu).getByTestId('user-menu-theme-row')).toHaveTextContent(bg.common.theme);
  expect(within(menu).getByTestId('user-menu-language-row')).toHaveTextContent(bg.common.language);
  expect(links).toEqual([[n.profile, '/me/profile']]);
  expect(within(menu).getByRole('menuitem', { name: bg.common.signOut })).toBeInTheDocument();
}

const PLAYER_ITEMS = [
  [n.play, '/venues'],
  [n.bookings, '/me/bookings'],
  [n.profile, '/me/profile'],
];
const CLUB_ITEMS = [
  [n.calendar, `/t/${SLUG}/admin/calendar`],
  [n.courts, `/t/${SLUG}/admin/courts`],
  [n.pricing, `/t/${SLUG}/admin/pricing`],
  [n.photos, `/t/${SLUG}/admin/photos`],
  [n.players, `/t/${SLUG}/admin/players`],
  [n.staff, `/t/${SLUG}/admin/staff`],
  [n.reports, `/t/${SLUG}/admin/reports`],
];

beforeEach(() => {
  installFakeFetch(() => ok({ items: [], nextCursor: null, unreadCount: 0 }));
  pathname = '/venues';
  modules = { openPlay: false, messaging: false };
  desktopViewport();
  signOut.mockReset();
  signedInIdentity.mockReset();
  resolveLanding.mockReset();
  resolveLanding.mockResolvedValue(PLAYER);
  resolvePlatformAuthority.mockReset();
  resolvePlatformAuthority.mockResolvedValue(NO_GRANT);
  resolveTenantPageContext.mockReset();
  resolveTenantPageContext.mockResolvedValue(membership('OWNER'));
  clubResourceNouns.mockReset();
  clubResourceNouns.mockResolvedValue('court');
});

describe('signed out: the public site’s header and footer', () => {
  it('the header’s Играй and Вход, the footer, the tab bar, and no AppShell', async () => {
    signedInIdentity.mockResolvedValue(null);
    const { container } = await renderChrome();

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: bg.common.appName })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      within(within(header).getByRole('navigation', { name: bg.common.ui.mainNav })).getByRole(
        'link',
        { name: n.play },
      ),
    ).toHaveAttribute('href', '/venues');
    expect(within(header).getByRole('link', { name: bg.login.title })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(container.querySelector('[data-app-shell]')).toBeNull();
    expect(screen.getByTestId('site-footer')).toBeInTheDocument();
    expect(barTabs()).toEqual([
      [n.play, '/venues'],
      [n.signIn, '/login'],
    ]);
    // The chrome owns the one <main>, and the page is in it.
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('the-page'));
    // No account, no bell, and nothing asked about one.
    expect(screen.queryByTestId('header-notifications')).not.toBeInTheDocument();
    expect(resolveLanding).not.toHaveBeenCalled();
    expect(resolvePlatformAuthority).not.toHaveBeenCalled();
    // A visitor's frame carries the essential-only notice (#370).
    expect(screen.getByTestId('cookie-notice')).toHaveTextContent(bg.common.cookieNotice.text);
  });
});

describe('PLAYER: the AppShell with the player’s sidebar', () => {
  beforeEach(() => signedInIdentity.mockResolvedValue(IVO));

  it('Играй, Резервации, Профил in the left rail; no platform, no admin', async () => {
    const { container } = await renderChrome();

    expect(container.querySelector('[data-app-shell]')).not.toBeNull();
    expect(railLinks()).toEqual(PLAYER_ITEMS);
    expect(within(railNav()).queryByText(n.platform)).not.toBeInTheDocument();
    expect(container.querySelectorAll('a[href^="/t/"]')).toHaveLength(0);
    expect(within(railNav()).getByRole('link', { name: n.play })).toHaveAttribute(
      'data-testid',
      'nav-venues',
    );
  });

  it('the top bar: the wordmark to Играй, the bell, and the account menu', async () => {
    await renderChrome();

    const banner = screen.getByRole('banner');
    expect(within(banner).getByTestId('shell-wordmark')).toHaveAttribute('href', '/venues');
    expect(within(banner).getByRole('button', { name: n.notifications })).toBeInTheDocument();
    // At every width, as in every shell (owner, 2026-10-08).
    expect(screen.getByTestId('top-chrome-user-menu').closest('.hidden')).toBeNull();
    expectTheMenu();
  });

  it('the rail’s foot: the name and Играч; no gear without an admin to open; Изход', async () => {
    await renderChrome();
    const foot = railFoot();
    expect(foot.lines).toEqual(['Ivo', bg.admin.staff.role.PLAYER]);
    expect(foot.gear).toBeNull();
    fireEvent.click(foot.signOut);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });

  it('none of the public chrome: no Вход, no footer, one <main> with the page in it', async () => {
    await renderChrome();

    expect(screen.queryByRole('link', { name: bg.login.title })).not.toBeInTheDocument();
    expect(screen.queryByTestId('site-footer')).not.toBeInTheDocument();
    // The cookie notice is a visitor's; an account's shell has none (#370).
    expect(screen.queryByTestId('cookie-notice')).not.toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('the-page'));
  });

  it('below md: the tab bar Играй · Резервации · Профил, and the drawer holds every item', async () => {
    await renderChrome();
    expect(barTabs()).toEqual(PLAYER_ITEMS);

    fireEvent.click(screen.getByTestId('nav-toggle'));
    const drawer = screen.getByRole('dialog', { name: n.menu });
    const drawerNav = within(drawer).getByRole('navigation', { name: bg.common.ui.mainNav });
    expect(within(drawerNav).getAllByRole('link').map(row)).toEqual(PLAYER_ITEMS);
    // The drawer ends in the rail's foot; a player has no way out to list.
    expect(within(drawer).queryByTestId('drawer-account')).not.toBeInTheDocument();
    const foot = within(drawer).getByTestId('sidebar-account');
    expect(within(foot).getByTestId('sidebar-identity')).toHaveTextContent('Ivo');
    fireEvent.click(within(foot).getByRole('button', { name: bg.common.signOut }));
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });

  it('marks the current page in the rail', async () => {
    pathname = '/me/bookings/abc';
    await renderChrome();
    expect(within(railNav()).getByRole('link', { name: n.bookings })).toHaveAttribute(
      'data-testid',
      'nav-bookings',
    );
    expect(within(railNav()).getByRole('link', { name: n.bookings }).className).not.toEqual(
      within(railNav()).getByRole('link', { name: n.play }).className,
    );
  });
});

describe('COACH: a player’s items in the same frame, until the coach module ships', () => {
  it('Играй, Резервации, Профил, and the bar’s same three', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(COACH);
    await renderChrome();

    expect(railLinks()).toEqual(PLAYER_ITEMS);
    expect(barTabs()).toEqual(PLAYER_ITEMS);
    expect(screen.queryByTestId('shell-context-name')).not.toBeInTheDocument();
  });

  it('its foot names a coach, with no gear; its menu is every shell’s', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(COACH);
    await renderChrome();
    expect(railFoot().lines).toEqual(['Ivo', bg.admin.staff.role.COACH]);
    expect(railFoot().gear).toBeNull();
    expectTheMenu();
  });
});

describe('a platform grant holder: "Платформа" lists the pages the grant opens (#345)', () => {
  beforeEach(() => signedInIdentity.mockResolvedValue(IVO));

  it('a moderator: Модерация and Сигурност, from the platform layout’s own filter', async () => {
    resolvePlatformAuthority.mockResolvedValue(MODERATOR);
    await renderChrome();

    expect(railLinks()).toEqual([
      ...PLAYER_ITEMS,
      [n.moderation, '/platform/moderation'],
      [n.security, '/platform/security'],
    ]);
    expect(within(railNav()).getByText(n.platform)).toBeInTheDocument();
    expect(resolvePlatformAuthority).toHaveBeenCalledWith('u1');
    // The platform is the rail's, so the menu does not repeat it.
    expect(menuRows().links).toEqual([[n.profile, '/me/profile']]);
  });

  it('its foot: the grant on the third line, and the gear to /platform', async () => {
    resolvePlatformAuthority.mockResolvedValue(MODERATOR);
    await renderChrome();
    expect(railFoot()).toMatchObject({
      lines: ['Ivo', bg.admin.staff.role.PLAYER, n.platform],
      gear: [n.platform, '/platform'],
    });
  });

  it('every capability: all five platform pages', async () => {
    resolvePlatformAuthority.mockResolvedValue(EVERY_CAPABILITY);
    await renderChrome();

    expect(railLinks().slice(PLAYER_ITEMS.length)).toEqual([
      [n.moderation, '/platform/moderation'],
      [n.fees, '/platform/fees'],
      [n.usage, '/platform/usage'],
      [n.contactRequests, '/platform/contact-requests'],
      [n.security, '/platform/security'],
    ]);
  });

  it('a lapsed grant (no capabilities): no Платформа at all', async () => {
    resolvePlatformAuthority.mockResolvedValue(NO_GRANT);
    await renderChrome();

    expect(railLinks()).toEqual(PLAYER_ITEMS);
    expect(within(railNav()).queryByText(n.platform)).not.toBeInTheDocument();
  });

  it('the drawer holds the platform too', async () => {
    resolvePlatformAuthority.mockResolvedValue(MODERATOR);
    await renderChrome();
    fireEvent.click(screen.getByTestId('nav-toggle'));
    const drawer = screen.getByRole('dialog', { name: n.menu });
    expect(within(drawer).getByRole('link', { name: n.moderation })).toHaveAttribute(
      'href',
      '/platform/moderation',
    );
  });
});

describe('the modules hide what has not shipped (#375, #376)', () => {
  beforeEach(() => signedInIdentity.mockResolvedValue(IVO));

  it('off (the default): no Игри and no Съобщения, in the rail or the bar', async () => {
    await renderChrome();
    expect(screen.queryByRole('link', { name: n.games })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: n.messages })).not.toBeInTheDocument();
  });

  it('on: Игри in the rail and the bar, Съобщения in the rail only', async () => {
    modules = { openPlay: true, messaging: true };
    await renderChrome();
    expect(railLinks()).toEqual([
      [n.play, '/venues'],
      [n.games, '/games'],
      [n.bookings, '/me/bookings'],
      [n.messages, '/messages'],
      [n.profile, '/me/profile'],
    ]);
    expect(barTabs()).toEqual([
      [n.play, '/venues'],
      [n.games, '/games'],
      [n.bookings, '/me/bookings'],
      [n.profile, '/me/profile'],
    ]);
  });

  it('a coach gets them too, a visitor never', async () => {
    modules = { openPlay: true, messaging: true };
    resolveLanding.mockResolvedValue(COACH);
    await renderChrome();
    expect(within(railNav()).getByRole('link', { name: n.games })).toBeInTheDocument();
  });
});

describe('a CLUB account on a public page: its club admin’s frame, never a player’s', () => {
  beforeEach(() => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(CLUB);
  });

  it('OWNER: every admin page in the rail, and no Играй or Резервации', async () => {
    const { container } = await renderChrome();

    expect(container.querySelector('[data-app-shell]')).not.toBeNull();
    expect(railLinks()).toEqual(CLUB_ITEMS);
    expect(within(railNav()).queryByRole('link', { name: n.play })).not.toBeInTheDocument();
    expect(within(railNav()).queryByRole('link', { name: n.bookings })).not.toBeInTheDocument();
    // The membership is read for THIS club, the one it lands on.
    expect(resolveTenantPageContext).toHaveBeenCalledWith(SLUG);
  });

  it('the admin’s top bar: its name back to the admin, its public page, the bell, the menu', async () => {
    await renderChrome();

    expect(screen.getByTestId('shell-context-name')).toHaveAttribute('href', `/t/${SLUG}/admin`);
    expect(screen.getByTestId('shell-context-name')).toHaveTextContent('Sofia Padel');
    expect(screen.getByTestId('shell-public-link')).toHaveAttribute('href', `/clubs/${SLUG}`);
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: n.notifications }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-admin')).not.toBeInTheDocument();
    expectTheMenu();
  });

  it('its foot: the name, the club, the role; the gear to the club admin', async () => {
    await renderChrome();
    expect(railFoot()).toMatchObject({
      lines: ['Ivo', 'Sofia Padel', bg.admin.staff.role.OWNER],
      gear: [n.admin, `/t/${SLUG}/admin`],
    });
  });

  it('below md: the admin’s bar, Календар · Кортове · Играчи · Още', async () => {
    await renderChrome();
    expect(barTabs()).toEqual([
      [n.calendar, `/t/${SLUG}/admin/calendar`],
      [n.courts, `/t/${SLUG}/admin/courts`],
      [n.players, `/t/${SLUG}/admin/players`],
    ]);
    expect(within(bar()).getByRole('button', { name: n.more })).toBeInTheDocument();
  });

  it('a karting club: its courts screen is "Писти", in the rail and on the bar', async () => {
    clubResourceNouns.mockResolvedValue('track');
    await renderChrome();

    // What it plays on is read for its own club, by the id its membership names.
    expect(clubResourceNouns).toHaveBeenCalledWith('csofia');
    expect(within(railNav()).getByRole('link', { name: n.track.courts })).toHaveAttribute(
      'href',
      `/t/${SLUG}/admin/courts`,
    );
    expect(within(railNav()).queryByRole('link', { name: n.courts })).not.toBeInTheDocument();
    expect(barTabs()).toContainEqual([n.track.courts, `/t/${SLUG}/admin/courts`]);
    expect(n.track.courts).toBe('Писти');
  });

  it('courts and a track: "Кортове и писти", the courts screen’s own wording', async () => {
    clubResourceNouns.mockResolvedValue('courtTrack');
    await renderChrome();

    expect(within(railNav()).getByRole('link', { name: n.courtTrack.courts })).toHaveAttribute(
      'href',
      `/t/${SLUG}/admin/courts`,
    );
    expect(n.courtTrack.courts).toBe(bg.admin.courts.courtTrack.title);
  });

  it('what it plays on unreadable: "Кортове", and the frame stands', async () => {
    clubResourceNouns.mockRejectedValue(new Error('database down'));
    await renderChrome();
    expect(railLinks()).toEqual(CLUB_ITEMS);
  });

  it('STAFF: only the pages the role opens', async () => {
    resolveTenantPageContext.mockResolvedValue(membership('STAFF'));
    await renderChrome();
    expect(railLinks()).toEqual([
      [n.calendar, `/t/${SLUG}/admin/calendar`],
      [n.players, `/t/${SLUG}/admin/players`],
    ]);
  });

  it('a club account that also holds a grant: the gear stays the club admin’s, Платформа is in the list', async () => {
    resolvePlatformAuthority.mockResolvedValue(MODERATOR);
    await renderChrome();
    expect(railLinks()).toEqual([
      ...CLUB_ITEMS,
      [n.moderation, '/platform/moderation'],
      [n.security, '/platform/security'],
    ]);
    expect(within(railNav()).getByText(n.platform)).toBeInTheDocument();
    expect(railFoot().gear).toEqual([n.admin, `/t/${SLUG}/admin`]);
    expect(menuRows().links).toEqual([[n.profile, '/me/profile']]);
  });

  it('its club not live: the club frame with no admin pages, still not a player’s', async () => {
    resolveLanding.mockResolvedValue({ href: '/', reason: 'club-unavailable', club: null });
    const { container } = await renderChrome();

    expect(container.querySelector('[data-app-shell]')).not.toBeNull();
    expect(within(railNav()).queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByTestId('shell-context-name')).not.toBeInTheDocument();
    expect(menuRows().links).toEqual([[n.profile, '/me/profile']]);
    expect(resolveTenantPageContext).not.toHaveBeenCalled();
    // No club to name and no admin to open.
    expect(railFoot()).toMatchObject({ lines: ['Ivo'], gear: null });
  });

  it('an undecided account that lands on a club’s admin wears that club’s frame', async () => {
    resolveLanding.mockResolvedValue({ ...CLUB, reason: 'undecided' });
    await renderChrome();
    expect(railLinks()).toEqual(CLUB_ITEMS);
  });
});

describe('a failed read does not break the page (#319)', () => {
  it('identity unreadable: the signed-out chrome', async () => {
    signedInIdentity.mockRejectedValue(new Error('session store down'));
    await renderChrome();
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: bg.login.title }),
    ).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('landing unreadable: a player’s frame, no admin', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockRejectedValue(new Error('database down'));
    await renderChrome();
    expect(railLinks()).toEqual(PLAYER_ITEMS);
  });

  it('the club’s membership unreadable: its frame with no admin pages', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(CLUB);
    resolveTenantPageContext.mockRejectedValue(new Error('database down'));
    await renderChrome();
    expect(within(railNav()).queryAllByRole('link')).toHaveLength(0);
    expect(within(railNav()).queryByRole('link', { name: n.play })).not.toBeInTheDocument();
  });
});
