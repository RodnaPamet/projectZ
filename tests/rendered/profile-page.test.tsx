import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { SWRConfig } from 'swr';

import { ProfileView } from '@/app/(app)/me/profile/ProfileView';
import type { MeDto } from '@/app/api/v1/_lib/dto';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LOCALE_COOKIE } from '@/lib/locale-constants';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';

/**
 * `/me/profile` (#362): the Профил tab's page.
 *
 *   identity · Настройки (Език, Тема) · Поверителност · (Платформа) · Изход
 *
 * The theme row and Изход are phone-only (`md:hidden`): from `md` the avatar's
 * menu holds them, and one control is never on screen twice. The language is
 * only here, and it is the USER's: the switch saves the record and refreshes
 * the token before the cookie, so the middleware does not flip it back.
 */
const signOut = jest.fn();
const getCsrfToken = jest.fn(async () => 'csrf-1');
jest.mock('next-auth/react', () => ({
  signOut: (...a: unknown[]) => signOut(...a),
  getCsrfToken: () => getCsrfToken(),
}));

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/me/profile',
}));

const saveMyLocaleAction = jest.fn();
jest.mock('@/app/(app)/me/profile/actions', () => ({
  saveMyLocaleAction: (...a: unknown[]) => saveMyLocaleAction(...a),
}));

const fetchMock = jest.fn();

const p = bg.profile;

/** `GET /api/v1/me` as the page seeds it (#359's sections). */
const account = (over: Partial<MeDto> = {}): MeDto => ({
  id: 'usr_ivo',
  name: 'Ivo',
  email: 'ivo@example.bg',
  avatarUrl: null,
  locale: 'bg',
  sports: [],
  accountKind: 'PLAYER',
  landing: { reason: 'player', club: null },
  ...over,
});

function renderProfile(
  platformHref: string | null = null,
  opts: { account?: MeDto; showSports?: boolean } = {},
) {
  const seed = opts.account ?? account();
  return render(
    withIntl(
      // No revalidation: the seed is what is under test, and the fetch mock
      // below counts only the language switch's calls.
      <SWRConfig
        value={{ provider: () => new Map(), revalidateOnMount: false, revalidateOnFocus: false }}
      >
        <TooltipProvider>
          <ProfileView
            name={seed.name}
            email="ivo@example.bg"
            platformHref={platformHref}
            account={seed}
            showSports={opts.showSports ?? true}
            notificationSettings={{
              email: { confirmation: true, reminder: true, clubChanges: true },
            }}
          />
        </TooltipProvider>
      </SWRConfig>,
    ),
  );
}

beforeEach(() => {
  signOut.mockReset();
  refresh.mockReset();
  saveMyLocaleAction.mockReset();
  saveMyLocaleAction.mockResolvedValue({ ok: true });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  global.fetch = fetchMock as unknown as typeof fetch;
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
});

describe('Профил — what every account sees', () => {
  it('names the person, as the page heading, with the email under it', () => {
    renderProfile();
    expect(screen.getByRole('heading', { level: 1, name: 'Ivo' })).toBeInTheDocument();
    expect(screen.getByTestId('profile-email')).toHaveTextContent('ivo@example.bg');
  });

  it('settings: the language at every width; the theme on a phone only', () => {
    renderProfile();
    const lang = screen.getByTestId('profile-language-row');
    expect(lang).toHaveTextContent(bg.common.language);
    expect(lang).not.toHaveClass('md:hidden');
    expect(within(lang).getAllByRole('radio')).toHaveLength(2);

    expect(screen.getByTestId('profile-theme-row')).toHaveClass('md:hidden');
  });

  it('privacy and data: a row that says the page is coming, not a link to a 404', () => {
    renderProfile();
    const row = screen.getByTestId('profile-privacy-row');
    expect(row).toHaveTextContent(p.privacyData);
    expect(row).toHaveTextContent(p.comingSoon);
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  });

  it('Изход is a real button, phone-only, and lands on the home page', () => {
    renderProfile();
    const out = screen.getByRole('button', { name: bg.common.signOut });
    expect(out).toHaveClass('md:hidden');
    fireEvent.click(out);
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });

  it('no Платформа without a live grant', () => {
    renderProfile(null);
    expect(screen.queryByTestId('profile-platform')).not.toBeInTheDocument();
  });
});

describe('Профил — a moderator', () => {
  it('Платформа, to /platform', () => {
    renderProfile('/platform');
    expect(screen.getByTestId('profile-platform')).toHaveAttribute('href', '/platform');
    expect(screen.getByRole('heading', { level: 2, name: bg.common.nav.platform })).toBeVisible();
  });
});

describe('Профил — the language is the user’s', () => {
  it('saves the record, refreshes the token, THEN sets the cookie and refreshes the page', async () => {
    renderProfile();
    const en = screen.getByRole('radio', { name: 'English' });

    await act(async () => {
      fireEvent.click(en);
    });

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(saveMyLocaleAction).toHaveBeenCalledWith('en');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ csrfToken: 'csrf-1', data: {} }),
      }),
    );
    // The token is refreshed before the cookie is written.
    expect(saveMyLocaleAction.mock.invocationCallOrder[0]!).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]!,
    );
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
    expect(screen.queryByTestId('profile-language-failed')).not.toBeInTheDocument();
  });

  it('a refused save leaves the language, the cookie and the token alone, and says so', async () => {
    saveMyLocaleAction.mockResolvedValue({ ok: false });
    renderProfile();

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    });

    await waitFor(() =>
      expect(screen.getByTestId('profile-language-failed')).toHaveTextContent(p.languageSaveFailed),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(`${LOCALE_COOKIE}=en`);
  });
});

describe('#359: the player sections, between the identity and the settings', () => {
  const after = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('a player sees Лични данни and Спортове и ниво, in that order, before Настройки', () => {
    renderProfile();
    const personal = screen.getByTestId('profile-personal');
    const sports = screen.getByTestId('profile-sports');
    expect(after(personal, sports)).toBe(true);
    expect(after(sports, screen.getByTestId('profile-language-row'))).toBe(true);
  });

  it('a CLUB account sets its name and has no sports section', () => {
    renderProfile(null, { account: account({ accountKind: 'CLUB' }), showSports: false });
    expect(screen.getByTestId('profile-personal')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-sports')).not.toBeInTheDocument();
  });

  it('N01: a new account is named by its email ONCE, and is asked for a name', () => {
    renderProfile(null, { account: account({ name: null }) });
    expect(screen.getByRole('heading', { level: 1, name: 'ivo@example.bg' })).toBeInTheDocument();
    expect(screen.queryByTestId('profile-email')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-name-prompt')).toHaveTextContent(p.personal.prompt);
  });

  it('a saved name is in the header at once, then the token is refreshed and the page re-read', async () => {
    const answer = (body: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => body,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/v1/me' && init?.method === 'PATCH'
        ? answer(JSON.stringify({ data: account({ name: 'Иво Иванов' }) }))
        : answer(''),
    );
    renderProfile();

    fireEvent.click(screen.getByRole('button', { name: p.personal.edit }));
    fireEvent.change(await screen.findByLabelText(p.personal.name), {
      target: { value: 'Иво Иванов' },
    });
    fireEvent.click(screen.getByRole('button', { name: p.personal.save }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Иво Иванов' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // The token is refreshed only after the server stored the name.
    expect(urls.indexOf('/api/auth/session')).toBeGreaterThan(urls.indexOf('/api/v1/me'));
    expect(urls.indexOf('/api/v1/me')).toBeGreaterThanOrEqual(0);
  });
});
