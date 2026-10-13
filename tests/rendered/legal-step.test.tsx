import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TermsStepPage from '@/app/(app)/start/terms/page';

import { enMessages, messages, withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * /start/terms (#462): the texts an account has not accepted yet, each linked,
 * and «Приемам»; or, when nothing is due after all, a refresh of the stale
 * session and on, with nothing asked.
 */

let locale: 'bg' | 'en' = 'bg';
jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    getLocale: async () => locale,
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale,
        messages:
          locale === 'en' ? require('../../messages/en.json') : require('../../messages/bg.json'),
        namespace,
      }),
  };
});

const redirect = jest.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});
jest.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

let signedIn: string | null = 'u1';
jest.mock('@/lib/auth/page-context', () => ({ requireSignedIn: async () => signedIn }));
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: async () => ({ href: '/me/bookings' }),
}));
const standing = jest.fn();
jest.mock('@/app-layer/usecases/legal-acceptance', () => ({
  legalStanding: (...args: unknown[]) => standing(...args),
}));
let hrefs: Record<string, string | null> = { terms: '/terms', privacy: '/privacy', cookies: null };
jest.mock('@/lib/legal/texts', () => ({ legalHrefs: async () => hrefs }));
jest.mock('@/components/layout/SignOutButton', () => ({
  SignOutButton: () => <button type="button">sign out</button>,
}));

const accept = jest.fn();
jest.mock('@/lib/data/use-v1-mutation', () => ({
  useV1Mutation: () => ({ trigger: (...args: unknown[]) => accept(...args), isMutating: false }),
}));
const refreshSession = jest.fn();
jest.mock('@/lib/auth/refresh-session', () => ({
  refreshSession: (...args: unknown[]) => refreshSession(...args),
}));
const loadPage = jest.fn();
jest.mock('@/lib/navigation/load-page', () => ({
  loadPage: (...args: unknown[]) => loadPage(...args),
}));

const DUE = {
  current: { terms: '2026-11-01', privacy: '2026-11-01' },
  accepted: {},
  due: ['terms', 'privacy'],
};

const page = async (next?: string) =>
  render(
    withIntl(
      await resolveServerTree(
        await TermsStepPage({ searchParams: Promise.resolve(next ? { next } : {}) }),
      ),
      locale,
    ),
  );

beforeEach(() => {
  locale = 'bg';
  signedIn = 'u1';
  hrefs = { terms: '/terms', privacy: '/privacy', cookies: null };
  for (const m of [standing, accept, refreshSession, loadPage, redirect]) m.mockClear();
  standing.mockResolvedValue(DUE);
  accept.mockResolvedValue(undefined);
  refreshSession.mockResolvedValue(undefined);
});

describe('/start/terms', () => {
  const t = messages.onboarding.terms;

  it('lists each text that is due, linked, with its version', async () => {
    await page('/games');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t.title);
    const due = within(screen.getByTestId('legal-due'));
    expect(due.getByRole('link', { name: t.document.terms })).toHaveAttribute('href', '/terms');
    expect(due.getByRole('link', { name: t.document.privacy })).toHaveAttribute('href', '/privacy');
    expect(due.getAllByText('версия 2026-11-01')).toHaveLength(2);
    // The way out for someone who will not accept.
    expect(within(screen.getByTestId('legal-decline')).getByRole('link')).toHaveAttribute(
      'href',
      '/me/profile',
    );
  });

  it('only the text that changed is asked', async () => {
    standing.mockResolvedValue({ ...DUE, accepted: { privacy: '2026-11-01' }, due: ['terms'] });
    await page();
    const due = within(screen.getByTestId('legal-due'));
    expect(due.getAllByRole('listitem')).toHaveLength(1);
    expect(due.getByRole('link', { name: t.document.terms })).toBeInTheDocument();
  });

  it('«Приемам» records it, refreshes the session, then loads where they were going', async () => {
    await page('/games?tab=mine');
    await userEvent.click(screen.getByTestId('legal-accept'));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/games?tab=mine'));
    expect(accept).toHaveBeenCalledTimes(1);
    // In that order: a load before the refresh would be sent straight back here.
    expect(accept.mock.invocationCallOrder[0]!).toBeLessThan(
      refreshSession.mock.invocationCallOrder[0]!,
    );
    expect(refreshSession.mock.invocationCallOrder[0]!).toBeLessThan(
      loadPage.mock.invocationCallOrder[0]!,
    );
  });

  it('without a destination it goes where the account lands', async () => {
    await page();
    await userEvent.click(screen.getByTestId('legal-accept'));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/me/bookings'));
  });

  it('a destination off this site is not followed', async () => {
    await page('https://evil.example/x');
    await userEvent.click(screen.getByTestId('legal-accept'));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/me/bookings'));
  });

  it('a failed save says so and goes nowhere', async () => {
    accept.mockRejectedValue(new Error('offline'));
    await page('/games');
    await userEvent.click(screen.getByTestId('legal-accept'));
    expect(await screen.findByTestId('legal-error')).toHaveTextContent(t.error);
    expect(loadPage).not.toHaveBeenCalled();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('nothing due after all: the stale session is refreshed and the person goes on, unasked', async () => {
    standing.mockResolvedValue({ ...DUE, accepted: DUE.current, due: [] });
    await page('/games');
    expect(screen.queryByTestId('legal-accept')).toBeNull();
    expect(screen.getByTestId('legal-continuing')).toHaveTextContent(t.continuing);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/games'));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  it('and if that refresh fails it offers to try again, not a loop', async () => {
    standing.mockResolvedValue({ ...DUE, accepted: DUE.current, due: [] });
    refreshSession.mockRejectedValueOnce(new Error('offline'));
    await page('/games');
    expect(await screen.findByTestId('legal-error')).toBeInTheDocument();
    expect(loadPage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.retry }));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/games'));
  });

  it('signed out, it goes to sign-in and back here', async () => {
    signedIn = null;
    await expect(page('/games')).rejects.toThrow(
      `REDIRECT /login?next=${encodeURIComponent('/start/terms?next=%2Fgames')}`,
    );
  });

  it('in English', async () => {
    locale = 'en';
    await page();
    const e = enMessages.onboarding.terms;
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(e.title);
    expect(screen.getByTestId('legal-accept')).toHaveTextContent(e.accept);
    expect(screen.getAllByText('version 2026-11-01')).toHaveLength(2);
  });
});
