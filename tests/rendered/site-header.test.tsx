import { render, screen, within } from '@testing-library/react';

import { SiteHeader } from '@/components/layout/SiteHeader';
import { HOME, PLAYER_HOME, type LandingDecision } from '@/lib/auth/landing';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';

/**
 * SIGNING IN HAS TO BE VISIBLE.
 *
 * Before this header, the homepage read no session at all: a successful Google
 * round trip returned you to a page identical to the one you left. It was
 * reported twice as "I logged in and came back to the same screen" — the first
 * time a real defect (#223), the second time a sign-in that had worked
 * perfectly with nothing on screen to say so.
 *
 * An app with no observable difference between signed in and signed out cannot
 * be tested by a human either, which is why these assert on what is RENDERED
 * rather than on the session helper's return value.
 *
 * Since T20 the header sits on inflect's vendored NavBar slots, its links show
 * from `md` (the bottom tab bar has them below), and the name and sign-out
 * live in the vendored account menu. jsdom applies no media queries, so every
 * width's markup is here at once; the phone half is the tab bar's test and
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

// Where `/start` would land the person — the header links a club account back
// to it. It reaches Prisma, which has no business loading under jsdom; what it
// returns is the input here.
const resolveLanding = jest.fn();
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: (...args: unknown[]) => resolveLanding(...args),
}));

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

const renderHeader = async () => render(withIntl(await SiteHeader()));

const IVO = { userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' };
const PLAYER: LandingDecision = { href: PLAYER_HOME, reason: 'player', club: null };
const CLUB: LandingDecision = {
  href: '/t/sofia-padel/admin/calendar',
  reason: 'club',
  club: { tenantId: 'csofia', tenantSlug: 'sofia-padel', tenantName: 'Sofia Padel' },
};

const PLAY = bg.common.nav.play;
const MINE = bg.common.nav.myBookings;
const SIGN_IN = bg.login.title;
const accountMenu = (name: string) => bg.nav.accountMenuFor.replace('{name}', name);
const topNav = () => screen.getByRole('navigation', { name: bg.common.ui.mainNav });

beforeEach(() => {
  pathname = '/venues';
  signedInIdentity.mockReset();
  resolveLanding.mockReset();
  resolveLanding.mockResolvedValue(PLAYER);
});

describe('SiteHeader — signed out', () => {
  it('offers sign-in and Discover, and no account', async () => {
    signedInIdentity.mockResolvedValue(null);
    await renderHeader();

    expect(screen.getByRole('link', { name: SIGN_IN })).toHaveAttribute('href', '/login');
    expect(within(topNav()).getByRole('link', { name: PLAY })).toHaveAttribute('href', '/venues');
    // "My bookings" to a stranger is a link to a redirect.
    expect(screen.queryByRole('link', { name: MINE })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Меню на акаунта/ })).not.toBeInTheDocument();
    // …and a stranger has no account to read, so nothing asks.
    expect(resolveLanding).not.toHaveBeenCalled();
  });

  it('does not link /login to itself (#319)', async () => {
    signedInIdentity.mockResolvedValue(null);
    pathname = '/login';
    await renderHeader();

    expect(screen.queryByRole('link', { name: SIGN_IN })).not.toBeInTheDocument();
    expect(within(topNav()).getByRole('link', { name: PLAY })).toBeInTheDocument();
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

describe('SiteHeader — per landing reason', () => {
  it('player: Discover and My bookings, an account menu that names them, no club', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    await renderHeader();

    const nav = topNav();
    expect(within(nav).getByRole('link', { name: PLAY })).toHaveAttribute('href', '/venues');
    // The link that makes /me/bookings reachable from a desktop (#224).
    expect(within(nav).getByRole('link', { name: MINE })).toHaveAttribute('href', '/me/bookings');
    expect(screen.getByRole('button', { name: accountMenu('Ivo') })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-club')).not.toBeInTheDocument();
    // No sign-in link while signed in — offering one implies it did not work.
    expect(screen.queryByRole('link', { name: SIGN_IN })).not.toBeInTheDocument();
    expect(resolveLanding).toHaveBeenCalledWith('u1');
  });

  it('names the account by its email when the provider gave no name', async () => {
    // An OAuth profile with no name is ordinary, and a blank trigger reads as broken.
    signedInIdentity.mockResolvedValue({ ...IVO, name: null });
    await renderHeader();

    expect(screen.getByRole('button', { name: accountMenu('ivo@example.bg') })).toBeInTheDocument();
  });

  it('club: the way back to its one club, and no My bookings (#263)', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue(CLUB);
    await renderHeader();

    expect(screen.getByRole('link', { name: 'Sofia Padel' })).toHaveAttribute(
      'href',
      '/t/sofia-padel/admin/calendar',
    );
    expect(screen.queryByRole('link', { name: MINE })).not.toBeInTheDocument();
    expect(within(topNav()).getByRole('link', { name: PLAY })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: accountMenu('Ivo') })).toBeInTheDocument();
    // One account, one kind: no switcher, no picker.
    expect(screen.queryByRole('button', { name: /Смяна на ролята/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('club-unavailable: neither a club nor My bookings, still a way out', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue({ href: HOME, reason: 'club-unavailable', club: null });
    await renderHeader();

    expect(screen.queryByRole('link', { name: MINE })).not.toBeInTheDocument();
    expect(screen.queryByTestId('site-header-club')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: accountMenu('Ivo') })).toBeInTheDocument();
  });

  it('undecided, with no club to land on: a player’s links', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue({ href: PLAYER_HOME, reason: 'undecided', club: null });
    await renderHeader();

    expect(within(topNav()).getByRole('link', { name: MINE })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-club')).not.toBeInTheDocument();
  });

  it('coach: a player’s links', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockResolvedValue({ href: PLAYER_HOME, reason: 'coach', club: null });
    await renderHeader();

    expect(within(topNav()).getByRole('link', { name: MINE })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-club')).not.toBeInTheDocument();
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

  it('landing unreadable: a player’s links and no club link', async () => {
    signedInIdentity.mockResolvedValue(IVO);
    resolveLanding.mockRejectedValue(new Error('database down'));
    await renderHeader();

    expect(within(topNav()).getByRole('link', { name: MINE })).toBeInTheDocument();
    expect(screen.queryByTestId('site-header-club')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: accountMenu('Ivo') })).toBeInTheDocument();
  });
});
