import { render, screen } from '@testing-library/react';

import { SiteHeader } from '@/components/layout/SiteHeader';
import { HOME, PLAYER_HOME, type LandingDecision } from '@/lib/auth/landing';

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
 */
jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));

const signedInIdentity = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  signedInIdentity: () => signedInIdentity(),
}));

// Where `/start` would land the person — the header links back to it. It
// reaches Prisma, which has no business loading under jsdom; what it returns is
// the input here.
const resolveLanding = jest.fn();
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: (...args: unknown[]) => resolveLanding(...args),
}));

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    // `as unknown as` and not a direct cast: the catalogue is NESTED —
    // `common.error.title` is an object, not a string — so the obvious
    // Record<string, Record<string, string>> does not describe it and tsc
    // rejects the conversion. Values are narrowed at the point of use instead.
    const messages = (await import('../../messages/bg.json')).default as unknown as Record<
      string,
      Record<string, unknown>
    >;
    return (key: string) => {
      const value = messages[ns]?.[key];
      return typeof value === 'string' ? value : `${ns}.${key}`;
    };
  },
}));

const renderHeader = async () => render(withIntl(await SiteHeader()));

const PLAYER: LandingDecision = { href: PLAYER_HOME, reason: 'player', club: null };

const CLUB: LandingDecision = {
  href: '/t/sofia-padel/admin/calendar',
  reason: 'club',
  club: { tenantId: 'csofia', tenantSlug: 'sofia-padel', tenantName: 'Sofia Padel' },
};

beforeEach(() => {
  signedInIdentity.mockReset();
  resolveLanding.mockReset();
  // A player, unless a test says otherwise.
  resolveLanding.mockResolvedValue(PLAYER);
});

describe('SiteHeader', () => {
  it('names the signed-in person and offers a way out', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    await renderHeader();

    expect(screen.getByText('Ivo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Изход' })).toBeInTheDocument();
    // The only thing in the app that points at /me/bookings. Without it the
    // page is unreachable, which is the failure #224 exists to describe.
    expect(screen.getByRole('link', { name: 'Моите резервации' })).toHaveAttribute(
      'href',
      '/me/bookings',
    );
    // No sign-in link while signed in — offering one implies it did not work.
    expect(screen.queryByRole('link', { name: 'Вход' })).not.toBeInTheDocument();
  });

  it('falls back to the email when the provider gave no name', async () => {
    // An OAuth profile with no name is ordinary, and a blank greeting beside a
    // sign-out button reads as broken rather than as anonymous.
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: null, email: 'ivo@example.bg' });
    await renderHeader();

    expect(screen.getByText('ivo@example.bg')).toBeInTheDocument();
  });

  it('offers sign-in, and no sign-out, when nobody is signed in', async () => {
    signedInIdentity.mockResolvedValue(null);
    await renderHeader();

    expect(screen.getByRole('link', { name: 'Вход' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', { name: 'Изход' })).not.toBeInTheDocument();
    // "My bookings" to a stranger is a link to a redirect.
    expect(screen.queryByRole('link', { name: 'Моите резервации' })).not.toBeInTheDocument();
    // …and a stranger has no account to read, so nothing asks.
    expect(resolveLanding).not.toHaveBeenCalled();
  });

  it('has no role switcher any more — one account is one kind (#263)', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    resolveLanding.mockResolvedValue(CLUB);
    await renderHeader();

    expect(screen.queryByRole('button', { name: /Смяна на ролята/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('SiteHeader — the way back to your club (#263)', () => {
  it('names a club account’s club, and links where /start would land it', async () => {
    // The switcher used to be how a club account got back to its club from the
    // public pages. With one kind per account the header just says which club.
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    resolveLanding.mockResolvedValue(CLUB);
    await renderHeader();

    expect(screen.getByRole('link', { name: 'Sofia Padel' })).toHaveAttribute(
      'href',
      '/t/sofia-padel/admin/calendar',
    );
    // A club account is not a player: no "My bookings" for it.
    expect(screen.queryByRole('link', { name: 'Моите резервации' })).not.toBeInTheDocument();
    // Asked about the person signed in, and nobody else.
    expect(resolveLanding).toHaveBeenCalledWith('u1');
  });

  it('offers a player "My bookings", and no club', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    await renderHeader();

    expect(screen.getByRole('link', { name: 'Моите резервации' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sofia Padel' })).not.toBeInTheDocument();
  });

  it('offers neither to a club account whose club is gone', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    resolveLanding.mockResolvedValue({ href: HOME, reason: 'club-unavailable', club: null });
    await renderHeader();

    expect(screen.queryByRole('link', { name: 'Моите резервации' })).not.toBeInTheDocument();
    // Still somebody signed in, with a way out.
    expect(screen.getByRole('button', { name: 'Изход' })).toBeInTheDocument();
  });
});
