import { act, render, screen, within } from '@testing-library/react';
import { forwardRef, type AnchorHTMLAttributes } from 'react';

import { BottomTabBar, isTabBarHidden } from '@/components/layout/BottomTabBar';
import {
  MODULES_OFF,
  type ChromeModules,
  type PlayerChromeKind,
} from '@/components/layout/nav-items';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';

/**
 * The player's bottom tab bar (T20, #362): what a phone gets instead of the
 * header's links. jsdom applies no media queries, so `md:hidden` is not tested
 * here, only what the bar is when it shows; tests/e2e/mobile/player-shell.spec.ts
 * measures it at 393 px in a real browser and runs axe over it.
 *
 *   signed out          Играй · Вход
 *   PLAYER, COACH, —    Играй · (Игри) · Резервации · Профил
 *   CLUB                Играй · Админ · Профил
 */
let pathname = '/venues';
jest.mock('next/navigation', () => ({ usePathname: () => pathname }));

// next/link's `prefetch` never reaches the DOM, so the test link writes it
// down. What a Save-Data browser is offered is the point of one test below.
jest.mock('next/link', () => ({
  __esModule: true,
  default: forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: unknown; href: string }
  >(function Link({ prefetch, ...rest }, ref) {
    return <a ref={ref} data-prefetch={String(prefetch)} {...rest} />;
  }),
}));

function mockViewport(belowMd: boolean) {
  // Assigned, not redefined: rtl-setup defines it writable but not configurable.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 767.98px') ? belowMd : query.includes('1024px'),
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

function setSaveData(saveData: boolean | undefined) {
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value:
      saveData === undefined
        ? undefined
        : { saveData, addEventListener: jest.fn(), removeEventListener: jest.fn() },
  });
}

const n = bg.common.nav;
const ADMIN = '/t/sofia-padel/admin/calendar';
const OPEN_PLAY: ChromeModules = { openPlay: true, messaging: false };

const renderBar = (
  kind: PlayerChromeKind,
  opts: { modules?: ChromeModules; adminHref?: string | null } = {},
) =>
  render(
    withIntl(
      <BottomTabBar
        kind={kind}
        modules={opts.modules ?? MODULES_OFF}
        adminHref={opts.adminHref ?? null}
      />,
    ),
  );

const bar = () => screen.getByRole('navigation', { name: n.tabBar });
const tabs = () =>
  within(bar())
    .getAllByRole('link')
    .map((l) => [l.textContent, l.getAttribute('href')]);

beforeEach(() => {
  pathname = '/venues';
  mockViewport(true);
  setSaveData(undefined);
  document.documentElement.style.removeProperty('--app-bottom-inset');
});

describe('BottomTabBar — tabs by account kind (#362)', () => {
  it('signed out: Играй and Вход', () => {
    renderBar('signed-out');
    expect(tabs()).toEqual([
      [n.play, '/venues'],
      [n.signIn, '/login'],
    ]);
  });

  it('PLAYER (and COACH, and undecided): Играй, Резервации, Профил', () => {
    renderBar('player');
    expect(tabs()).toEqual([
      [n.play, '/venues'],
      [n.bookings, '/me/bookings'],
      [n.profile, '/me/profile'],
    ]);
  });

  it('CLUB: Играй, Админ (its own club), Профил; no Резервации', () => {
    renderBar('club', { adminHref: ADMIN });
    expect(tabs()).toEqual([
      [n.play, '/venues'],
      [n.admin, ADMIN],
      [n.profile, '/me/profile'],
    ]);
  });

  it('CLUB whose club is not live: no Админ tab to an admin that would refuse it', () => {
    renderBar('club', { adminHref: null });
    expect(tabs()).toEqual([
      [n.play, '/venues'],
      [n.profile, '/me/profile'],
    ]);
  });

  it('a PLAYER is never offered an admin, even if handed one', () => {
    renderBar('player', { adminHref: ADMIN });
    expect(within(bar()).queryByRole('link', { name: n.admin })).not.toBeInTheDocument();
  });

  it('every tab is a page: no menu button on the bar any more', () => {
    for (const kind of ['signed-out', 'player', 'club'] as const) {
      const { unmount } = renderBar(kind, { adminHref: ADMIN });
      expect(within(bar()).queryByRole('button')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('BottomTabBar — the Игри tab waits for its module', () => {
  it('modules off (the default): no Игри', () => {
    renderBar('player');
    expect(within(bar()).queryByRole('link', { name: n.games })).not.toBeInTheDocument();
  });

  it('modules.openPlay on: Игри, second', () => {
    renderBar('player', { modules: OPEN_PLAY });
    expect(tabs()).toEqual([
      [n.play, '/venues'],
      [n.games, '/games'],
      [n.bookings, '/me/bookings'],
      [n.profile, '/me/profile'],
    ]);
  });

  it('a CLUB account gets no Игри tab even with the module on', () => {
    renderBar('club', { modules: OPEN_PLAY, adminHref: ADMIN });
    expect(within(bar()).queryByRole('link', { name: n.games })).not.toBeInTheDocument();
  });
});

describe('BottomTabBar — accessibility', () => {
  it('marks the current tab, and only it, with aria-current AND the accent bar', () => {
    pathname = '/me/profile';
    renderBar('player');
    const profile = within(bar()).getByRole('link', { name: n.profile });
    expect(profile).toHaveAttribute('aria-current', 'page');
    expect(profile.querySelector('[data-tab-accent]')).not.toBeNull();

    const play = within(bar()).getByRole('link', { name: n.play });
    expect(play).not.toHaveAttribute('aria-current');
    expect(play.querySelector('[data-tab-accent]')).toBeNull();
  });

  it('a page below a tab keeps it current', () => {
    pathname = '/me/bookings/abc';
    renderBar('player');
    expect(within(bar()).getByRole('link', { name: n.bookings })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('every tab is a 44 px target, named by its label, its icon hidden', () => {
    renderBar('club', { adminHref: ADMIN });
    for (const t of within(bar()).getAllByRole('link')) {
      expect(t).toHaveClass('min-h-11', 'min-w-11');
      expect(t.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('pads itself clear of the home indicator, and hides from md', () => {
    renderBar('player');
    expect(bar().className).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
    expect(bar()).toHaveClass('md:hidden');
  });
});

describe('BottomTabBar — where it is not', () => {
  it.each(['/login', '/invite/abc123', '/offline'])('renders nothing on %s', (path) => {
    pathname = path;
    renderBar('signed-out');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it.each(['/', '/venues', '/me/bookings', '/me/profile'])('shows on %s', (path) => {
    expect(isTabBarHidden(path)).toBe(false);
  });

  it('does not hide on a page that merely starts with a hidden name', () => {
    expect(isTabBarHidden('/login-help')).toBe(false);
    expect(isTabBarHidden('/invite')).toBe(false);
  });
});

describe('BottomTabBar — prefetch and the bottom inset', () => {
  it('fully prefetches its tabs (docs/perf/navigation-policy.md)', () => {
    setSaveData(false);
    renderBar('player');
    for (const l of within(bar()).getAllByRole('link')) {
      expect(l).toHaveAttribute('data-prefetch', 'true');
    }
  });

  it('never fully prefetches the Админ tab: it leads into the admin', () => {
    setSaveData(false);
    renderBar('club', { adminHref: ADMIN });
    expect(within(bar()).getByRole('link', { name: n.admin })).toHaveAttribute(
      'data-prefetch',
      'null',
    );
    expect(within(bar()).getByRole('link', { name: n.play })).toHaveAttribute(
      'data-prefetch',
      'true',
    );
  });

  it('falls back to the default prefetch under Save-Data', () => {
    setSaveData(true);
    renderBar('player');
    for (const l of within(bar()).getAllByRole('link')) {
      expect(l).toHaveAttribute('data-prefetch', 'null');
    }
  });

  it('publishes its height as --app-bottom-inset below md, and takes it back', () => {
    const { unmount } = renderBar('player');
    expect(document.documentElement.style.getPropertyValue('--app-bottom-inset')).toBe(
      'calc(3.5rem + env(safe-area-inset-bottom))',
    );
    act(() => unmount());
    expect(document.documentElement.style.getPropertyValue('--app-bottom-inset')).toBe('');
  });

  it('sets no inset from md, where it is hidden', () => {
    mockViewport(false);
    renderBar('player');
    expect(document.documentElement.style.getPropertyValue('--app-bottom-inset')).toBe('');
  });
});
