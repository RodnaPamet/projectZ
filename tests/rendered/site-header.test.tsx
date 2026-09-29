import { render, screen } from '@testing-library/react';

import { SiteHeader } from '@/components/layout/SiteHeader';
import { landingContexts, PLAYER_CONTEXT } from '@/lib/auth/landing';

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

// The switcher's two server-side dependencies. Both reach Prisma, which has
// no business loading under jsdom; what they return is the input here.
const listLandingContexts = jest.fn();
jest.mock('@/app-layer/usecases/landing', () => ({
  listLandingContexts: (...args: unknown[]) => listLandingContexts(...args),
}));
jest.mock('@/app/(app)/start/actions', () => ({ switchContextAction: jest.fn() }));

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

const OWNER_AND_PLAYER = landingContexts([
  {
    tenantId: 'csofia',
    tenantSlug: 'sofia-padel',
    tenantName: 'Sofia Padel',
    role: 'OWNER',
    status: 'ACTIVE',
    tenantStatus: 'ACTIVE',
    createdAt: new Date('2026-01-01'),
  },
]);

const switcher = () => screen.queryByRole('button', { name: /Смяна на ролята/ });

beforeEach(() => {
  signedInIdentity.mockReset();
  listLandingContexts.mockReset();
  // A player and nothing else, unless a test says otherwise.
  listLandingContexts.mockResolvedValue([PLAYER_CONTEXT]);
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
    // …and a stranger has no roles to read, so nothing asks.
    expect(listLandingContexts).not.toHaveBeenCalled();
    expect(switcher()).not.toBeInTheDocument();
  });
});

describe('SiteHeader — the role switcher (#227)', () => {
  it('offers it to somebody who runs a club as well as playing', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    listLandingContexts.mockResolvedValue(OWNER_AND_PLAYER);
    await renderHeader();

    expect(switcher()).toBeInTheDocument();
    // Asked about the person signed in, and nobody else.
    expect(listLandingContexts).toHaveBeenCalledWith('u1');
  });

  it('does not offer it to somebody who only plays — there is nothing to switch to', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    await renderHeader();

    expect(switcher()).not.toBeInTheDocument();
    // The rest of the header is unchanged for them.
    expect(screen.getByRole('link', { name: 'Моите резервации' })).toBeInTheDocument();
  });
});
