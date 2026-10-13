import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import PhoneStepPage from '@/app/(app)/start/phone/page';
import { PhoneStep, phoneStepErrorKey } from '@/app/(app)/start/phone/PhoneStep';
import { PhoneRequiredNotice } from '@/components/phone/PhoneRequiredNotice';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { enMessages, messages, withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * The phone step (#500) against the REAL catalogues and a fake v1: the number,
 * then the code, then on to where the person was going; each refusal in
 * words; and the notice the other screens show when the API asks for it.
 */

const replace = jest.fn();
let pathname = '/games';
let search = new URLSearchParams();
const redirect = jest.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => search,
  redirect: (to: string) => redirect(to),
}));

const refreshSession = jest.fn();
jest.mock('@/lib/auth/refresh-session', () => ({
  refreshSession: (...args: unknown[]) => refreshSession(...args),
}));
const loadPage = jest.fn();
jest.mock('@/lib/navigation/load-page', () => ({
  loadPage: (...args: unknown[]) => loadPage(...args),
}));

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

let signedIn: string | null = 'usr_new';
jest.mock('@/lib/auth/page-context', () => ({ requireSignedIn: async () => signedIn }));
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: async () => ({ href: '/me/bookings' }),
}));
const standing = jest.fn();
jest.mock('@/app-layer/usecases/phone-verification', () => ({
  phoneStanding: (...args: unknown[]) => standing(...args),
}));
jest.mock('@/components/layout/SignOutButton', () => ({
  SignOutButton: () => <button type="button">sign out</button>,
}));

const s = messages.phone.step;

function mount(to = '/venues/alfa?confirm=1') {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ViewerScope viewerId="usr_new">
            <PhoneStep to={to} />
          </ViewerScope>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(() => {
  replace.mockReset();
  redirect.mockClear();
  refreshSession.mockReset();
  refreshSession.mockResolvedValue(undefined);
  loadPage.mockReset();
  document.cookie = 'pz_phone_later=; path=/; max-age=0';
  standing.mockReset();
  standing.mockResolvedValue({
    required: true,
    applies: true,
    verified: false,
    number: null,
    verifiedAt: null,
  });
  signedIn = 'usr_new';
  locale = 'bg';
  pathname = '/games';
  search = new URLSearchParams();
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('the phone step', () => {
  it('asks for the number first, and the button waits for one', () => {
    installFakeFetch(() => ok({}));
    mount();
    expect(screen.getByLabelText(s.number.label)).toHaveAttribute('type', 'tel');
    expect(screen.getByLabelText(s.number.label)).toHaveAttribute('autocomplete', 'tel');
    expect(screen.getByTestId('phone-send')).toBeDisabled();
    type('phone-input', '0888 123 456');
    expect(screen.getByTestId('phone-send')).toBeEnabled();
  });

  it('sends the number as typed, then asks for the code and says where it went', async () => {
    const calls = installFakeFetch(() =>
      ok({ sent: true, number: '+35988*****56', challenge: 'chal-1' }),
    );
    mount();
    type('phone-input', '0888 123 456');
    fireEvent.click(screen.getByTestId('phone-send'));

    expect(await screen.findByTestId('phone-sent-to')).toHaveTextContent('+35988*****56');
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v1/me/phone/start',
      body: { phone: '0888 123 456' },
    });
    const code = screen.getByLabelText(s.code.label);
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
  });

  it('confirms with the same number and the code, then goes on to where the person was going', async () => {
    const calls = installFakeFetch((c) =>
      c.url.endsWith('/start')
        ? ok({ sent: true, number: '+35988*****56', challenge: 'chal-1' })
        : ok({ id: 'usr_new' }),
    );
    mount('/venues/alfa?day=2026-10-20&confirm=1');
    type('phone-input', '0888 123 456');
    fireEvent.click(screen.getByTestId('phone-send'));
    await screen.findByTestId('phone-step-code');
    type('phone-code-input', '314 159');
    fireEvent.click(screen.getByTestId('phone-confirm'));

    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith('/venues/alfa?day=2026-10-20&confirm=1'),
    );
    // The session learns the number is confirmed BEFORE the next page loads,
    // or that page would send the person straight back here.
    expect(refreshSession.mock.invocationCallOrder[0]!).toBeLessThan(
      loadPage.mock.invocationCallOrder[0]!,
    );
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v1/me/phone/confirm',
      // The challenge the send answered goes back with the code.
      body: { phone: '0888 123 456', code: '314 159', challenge: 'chal-1' },
    });
  });

  it('a session that will not refresh does not keep a person whose number is confirmed', async () => {
    refreshSession.mockRejectedValue(new Error('offline'));
    installFakeFetch((c) =>
      c.url.endsWith('/start')
        ? ok({ sent: true, number: '+35988*****56', challenge: 'chal-1' })
        : ok({ id: 'usr_new' }),
    );
    mount('/games');
    type('phone-input', '0888 123 456');
    fireEvent.click(screen.getByTestId('phone-send'));
    await screen.findByTestId('phone-step-code');
    type('phone-code-input', '314159');
    fireEvent.click(screen.getByTestId('phone-confirm'));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/games'));
  });

  it.each([
    ['PHONE_INVALID', 400],
    ['PHONE_VERIFY_UNAVAILABLE', 503],
  ] as const)('a refused number says why: %s', async (code, status) => {
    installFakeFetch(() => fail(status, code));
    mount();
    type('phone-input', '12');
    fireEvent.click(screen.getByTestId('phone-send'));
    expect(await screen.findByTestId('phone-error')).toHaveTextContent(s.error[code]);
    // Still on the number: nothing was sent.
    expect(screen.getByTestId('phone-step-number')).toBeInTheDocument();
  });

  it.each([
    ['PHONE_CODE_WRONG', 400],
    ['PHONE_CODE_EXPIRED', 400],
    ['PHONE_IN_USE', 409],
  ] as const)('a refused code says why and stays on the code: %s', async (code, status) => {
    installFakeFetch((c) =>
      c.url.endsWith('/start')
        ? ok({ sent: true, number: '+35988*****56', challenge: 'chal-1' })
        : fail(status, code),
    );
    mount();
    type('phone-input', '0888 123 456');
    fireEvent.click(screen.getByTestId('phone-send'));
    await screen.findByTestId('phone-step-code');
    type('phone-code-input', '000000');
    fireEvent.click(screen.getByTestId('phone-confirm'));

    expect(await screen.findByTestId('phone-error')).toHaveTextContent(s.error[code]);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it('too many attempts is its own message, whatever the code in the body', () => {
    const e = (status: number, code: string) => new ApiClientError({ status, code, message: code });
    expect(phoneStepErrorKey(e(429, 'RATE_LIMITED'))).toBe('RATE_LIMITED');
    expect(phoneStepErrorKey(e(429, 'SOMETHING'))).toBe('RATE_LIMITED');
    expect(phoneStepErrorKey(e(500, 'INTERNAL'))).toBe('FAILED');
    expect(phoneStepErrorKey(new Error('offline'))).toBe('FAILED');
  });

  it('«Изпрати отново» sends a new code to the same number, says so, and confirms with the NEW challenge', async () => {
    let sends = 0;
    const calls = installFakeFetch((c) =>
      c.url.endsWith('/start')
        ? ok({ sent: true, number: '+35988*****56', challenge: `chal-${++sends}` })
        : ok({ id: 'usr_new' }),
    );
    mount();
    type('phone-input', '0888 123 456');
    fireEvent.click(screen.getByTestId('phone-send'));
    await screen.findByTestId('phone-step-code');
    fireEvent.click(screen.getByTestId('phone-resend'));

    expect(await screen.findByTestId('phone-resent')).toHaveTextContent(s.code.resent);
    expect(calls.filter((c) => c.url.endsWith('/start'))).toHaveLength(2);

    type('phone-code-input', '271828');
    fireEvent.click(screen.getByTestId('phone-confirm'));
    await waitFor(() => expect(loadPage).toHaveBeenCalled());
    // The first code is dead once a second was sent; so is its challenge.
    expect(calls.at(-1)!.body).toEqual({
      phone: '0888 123 456',
      code: '271828',
      challenge: 'chal-2',
    });
  });

  it('«Друг номер» goes back to the number, kept as typed', async () => {
    installFakeFetch(() => ok({ sent: true, number: '+35988*****56', challenge: 'chal-1' }));
    mount();
    type('phone-input', '0888 123 456');
    fireEvent.click(screen.getByTestId('phone-send'));
    await screen.findByTestId('phone-step-code');
    fireEvent.click(screen.getByTestId('phone-change'));
    expect(screen.getByTestId('phone-input')).toHaveValue('0888 123 456');
  });
});

describe('/start/phone', () => {
  const page = async (next?: string) =>
    render(
      withIntl(
        <DataProvider>
          <SWRConfig value={{ provider: () => new Map() }}>
            {await resolveServerTree(
              await PhoneStepPage({ searchParams: Promise.resolve(next ? { next } : {}) }),
            )}
          </SWRConfig>
        </DataProvider>,
        locale,
      ),
    );

  it('says what the number is for and who sees it, and offers a way out', async () => {
    installFakeFetch(() => ok({}));
    await page('/games');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(s.title);
    expect(screen.getByTestId('phone-privacy')).toHaveTextContent(s.privacy);
    expect(screen.getByTestId('phone-later')).toHaveTextContent(s.later);
  });

  it('«Не сега» is remembered in this browser, and goes on to where the person was going', async () => {
    installFakeFetch(() => ok({}));
    await page('/games?tab=mine');
    fireEvent.click(screen.getByTestId('phone-later'));
    expect(document.cookie).toContain('pz_phone_later=1');
    expect(loadPage).toHaveBeenCalledWith('/games?tab=mine');
    // Nothing was confirmed, and nothing is asked of the server.
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('an account with a number already is asked nothing: its session is refreshed and it goes on', async () => {
    standing.mockResolvedValue({
      required: true,
      applies: true,
      verified: true,
      number: '+35988*****56',
      verifiedAt: new Date(),
    });
    await page('/games?tab=mine');
    expect(screen.queryByTestId('phone-step-number')).toBeNull();
    expect(screen.getByTestId('phone-continuing')).toHaveTextContent(s.continuing);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/games?tab=mine'));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('nor is an account the rule is not for: a club’s, or one still choosing its kind', async () => {
    standing.mockResolvedValue({
      required: true,
      applies: false,
      verified: false,
      number: null,
      verifiedAt: null,
    });
    await page();
    expect(screen.queryByTestId('phone-step-number')).toBeNull();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/me/bookings'));
  });

  it('and if that refresh fails it offers to try again, not a loop', async () => {
    standing.mockResolvedValue({
      required: true,
      applies: false,
      verified: false,
      number: null,
      verifiedAt: null,
    });
    refreshSession.mockRejectedValueOnce(new Error('offline'));
    await page('/games');
    expect(await screen.findByTestId('phone-error')).toBeInTheDocument();
    expect(loadPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('phone-retry'));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/games'));
  });

  it('signed out, it goes to sign-in and back here', async () => {
    signedIn = null;
    await expect(page('/games')).rejects.toThrow(
      `REDIRECT /login?next=${encodeURIComponent('/start/phone?next=%2Fgames')}`,
    );
  });

  it('a destination off this site is not kept', async () => {
    installFakeFetch(() => ok({}));
    await page('https://evil.example/x');
    fireEvent.click(screen.getByTestId('phone-later'));
    expect(loadPage).toHaveBeenCalledWith('/me/bookings');
  });

  it('in English', async () => {
    locale = 'en';
    installFakeFetch(() => ok({}));
    await page();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      enMessages.phone.step.title,
    );
    expect(screen.getByTestId('phone-send')).toHaveTextContent(enMessages.phone.step.number.submit);
  });
});

describe('the "confirm a phone number first" notice', () => {
  const r = messages.phone.required;

  it('offers the step, and the way back to the page the person is on, query included', () => {
    pathname = '/games';
    search = new URLSearchParams('tab=open&sport=PADEL');
    render(withIntl(<PhoneRequiredNotice />));
    expect(screen.getByTestId('phone-required')).toHaveTextContent(r.title);
    expect(screen.getByTestId('phone-required-action')).toHaveAttribute(
      'href',
      `/start/phone?next=${encodeURIComponent('/games?tab=open&sport=PADEL')}`,
    );
  });

  it('or to the place the screen names', () => {
    render(withIntl(<PhoneRequiredNotice next="/venues/alfa?confirm=1" />));
    expect(screen.getByTestId('phone-required-action')).toHaveAttribute(
      'href',
      `/start/phone?next=${encodeURIComponent('/venues/alfa?confirm=1')}`,
    );
  });
});
