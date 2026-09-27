import { render, screen } from '@testing-library/react';

import { SiteHeader } from '@/components/layout/SiteHeader';

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

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const messages = (await import('../../messages/bg.json')).default as Record<
      string,
      Record<string, string>
    >;
    return (key: string) => messages[ns]?.[key] ?? `${ns}.${key}`;
  },
}));

const renderHeader = async () => render(withIntl(await SiteHeader()));

beforeEach(() => signedInIdentity.mockReset());

describe('SiteHeader', () => {
  it('names the signed-in person and offers a way out', async () => {
    signedInIdentity.mockResolvedValue({ userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' });
    await renderHeader();

    expect(screen.getByText('Ivo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Изход' })).toBeInTheDocument();
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
  });
});
