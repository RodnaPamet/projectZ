import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { forwardRef, type AnchorHTMLAttributes } from 'react';

import { BottomTabBar, isTabBarHidden } from '@/components/layout/BottomTabBar';
import type { PlayerChromeKind } from '@/components/layout/nav-items';
import { TooltipProvider } from '@/components/ui/tooltip';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';

/**
 * The player's bottom tab bar (T20): what a phone gets instead of the header's
 * links. jsdom applies no media queries, so `md:hidden` is not tested here,
 * only what the bar is when it shows; tests/e2e/mobile/player-shell.spec.ts
 * measures it at 393 px in a real browser.
 */
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));

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

/** Below md, and wide enough that the vendored menu is a dropdown jsdom can open. */
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

const IVO = { name: 'Ivo', email: 'ivo@example.bg' };
const n = bg.common.nav;

// The app mounts a TooltipProvider in Providers; the menu's theme row needs one.
const renderBar = (kind: PlayerChromeKind, identity: typeof IVO | null = IVO) =>
  render(
    withIntl(
      <TooltipProvider>
        <BottomTabBar kind={kind} identity={kind === 'signed-out' ? null : identity} />
      </TooltipProvider>,
    ),
  );

const bar = () => screen.getByRole('navigation', { name: n.tabBar });

beforeEach(() => {
  pathname = '/venues';
  mockViewport(true);
  setSaveData(undefined);
  document.documentElement.style.removeProperty('--app-bottom-inset');
});

describe('BottomTabBar — tabs by account kind (#263)', () => {
  it('signed out: Discover and Sign in', () => {
    renderBar('signed-out');
    const links = within(bar()).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      [n.play, '/venues'],
      [n.signIn, '/login'],
    ]);
    expect(within(bar()).queryByRole('button')).not.toBeInTheDocument();
  });

  it('player (and coach, and undecided): Discover, My bookings and Account', () => {
    renderBar('player');
    expect(
      within(bar())
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual(['/venues', '/me/bookings']);
    const account = within(bar()).getByRole('button', { name: n.account });
    expect(account).toHaveAttribute('aria-haspopup', 'menu');
    expect(account).toHaveAttribute('aria-expanded', 'false');
  });

  it('club: Discover and Account — no club tab, no My bookings', () => {
    renderBar('club');
    expect(
      within(bar())
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual(['/venues']);
    expect(within(bar()).getByRole('button', { name: n.account })).toBeInTheDocument();
    expect(within(bar()).queryByText(/\/t\//)).not.toBeInTheDocument();
  });
});

describe('BottomTabBar — accessibility', () => {
  it('marks the current tab, and only it', () => {
    pathname = '/me/bookings';
    renderBar('player');
    expect(within(bar()).getByRole('link', { name: n.myBookings })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(bar()).getByRole('link', { name: n.play })).not.toHaveAttribute('aria-current');
  });

  it('every tab is a 44 px target, with its label as its name and the icon hidden', () => {
    renderBar('player');
    const targets = [
      ...within(bar()).getAllByRole('link'),
      within(bar()).getByRole('button', { name: n.account }),
    ];
    expect(targets).toHaveLength(3);
    for (const t of targets) {
      expect(t).toHaveClass('min-h-11', 'min-w-11');
      expect(t.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('pads itself clear of the home indicator', () => {
    renderBar('player');
    expect(bar().className).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
  });

  it('the Account tab opens the vendored account menu, with sign-out', () => {
    renderBar('player');
    const account = within(bar()).getByRole('button', { name: n.account });
    fireEvent.click(account);

    expect(account).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: bg.nav.accountMenu });
    expect(within(menu).getByText('Ivo')).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: bg.common.signOut })).toBeInTheDocument();
  });

  it('the vendored trigger it opens is inert: no second, nameless tab stop', () => {
    renderBar('player');
    const trigger = screen.getByTestId('top-chrome-user-menu');
    expect(trigger.closest('[inert]')).not.toBeNull();
  });
});

describe('BottomTabBar — where it is not', () => {
  it.each(['/login', '/invite/abc123', '/offline'])('renders nothing on %s', (path) => {
    pathname = path;
    renderBar('signed-out');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it.each(['/', '/venues', '/me/bookings'])('shows on %s', (path) => {
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
