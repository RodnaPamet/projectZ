import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signIn } from 'next-auth/react';

import LoginPage from '@/app/(public)/login/page';

import { withIntl } from '../helpers/intl';

/**
 * WHERE A SIGN-IN ENDS, AS NEXT-AUTH IS TOLD (#227).
 *
 * The page decides a destination and the form hands it to `signIn`. These
 * click the real button and read what `signIn` received, because that value
 * is the whole contract: next-auth redirects there after the provider round
 * trip, and nothing downstream gets a second say.
 *
 * ═══ THE BUG THIS REPLACES ═══
 *
 * The middleware, the club layout, the invite page and `/me/bookings` all
 * send people here with `?next=`. This page read only `?callbackUrl=` and
 * defaulted to `/`, so every one of those deep links ended on the home page
 * — including the invite, whose page promises "after signing in you will
 * come back here".
 */
jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));
jest.mock('@/lib/auth/sign-in-methods', () => ({
  signInMethods: () => ({ google: 'configured', microsoft: 'configured' }),
}));

const ORIGIN = 'https://app.playerz.bg';
const realNextAuthUrl = process.env.NEXTAUTH_URL;

beforeAll(() => {
  process.env.NEXTAUTH_URL = ORIGIN;
});
afterAll(() => {
  process.env.NEXTAUTH_URL = realNextAuthUrl;
});
beforeEach(() => jest.mocked(signIn).mockReset());

/** Render /login with these query parameters, press Google, return the destination. */
async function destinationFor(params: Record<string, string | string[]>) {
  render(withIntl(await LoginPage({ searchParams: Promise.resolve(params) })));
  await userEvent.click(screen.getByRole('button', { name: /Google/ }));

  expect(signIn).toHaveBeenCalledTimes(1);
  const [provider, options] = jest.mocked(signIn).mock.calls[0]!;
  expect(provider).toBe('google');
  return (options as { callbackUrl: string }).callbackUrl;
}

describe('/login — where the sign-in ends', () => {
  it('with no destination of their own: /start, which lands them by role', async () => {
    expect(await destinationFor({})).toBe('/start');
  });

  it('honours ?next=, which is what the app itself writes', async () => {
    expect(await destinationFor({ next: '/invite/abc123' })).toBe('/invite/abc123');
  });

  it('keeps the query string of a deep link', async () => {
    expect(await destinationFor({ next: '/t/sofia/admin/calendar?day=2026-10-01' })).toBe(
      '/t/sofia/admin/calendar?day=2026-10-01',
    );
  });

  it('honours ?callbackUrl=, which is what next-auth writes', async () => {
    expect(await destinationFor({ callbackUrl: '/t/sofia/admin/staff' })).toBe(
      '/t/sofia/admin/staff',
    );
  });

  it('keeps next-auth’s absolute retry URL when it is on this site', async () => {
    expect(
      await destinationFor({ callbackUrl: `${ORIGIN}/me/bookings`, error: 'OAuthSignin' }),
    ).toBe('/me/bookings');
  });

  it('the old default of "/" now means role landing, not the home page', async () => {
    expect(await destinationFor({ callbackUrl: '/' })).toBe('/start');
  });

  it.each([
    '//evil.example/steal',
    '/\\evil.example',
    'https://evil.example/t/x',
    '/..//evil.example',
    'javascript:alert(1)',
  ])('does not become an open redirect for %s', async (evil) => {
    expect(await destinationFor({ next: evil })).toBe('/start');
  });

  it('treats a repeated parameter as no destination rather than guessing', async () => {
    expect(await destinationFor({ next: ['/me/bookings', '//evil.example'] })).toBe('/start');
  });

  it('still shows the error when next-auth sends one back', async () => {
    render(
      withIntl(await LoginPage({ searchParams: Promise.resolve({ error: 'OAuthCallback' }) })),
    );

    // The error notice, in its own token colour — it used to be a bare <p>
    // in `text-destructive`, a class this theme does not define.
    expect(screen.getByRole('alert')).toHaveClass('text-content-error');
  });

  it('is one landmark with one level-one heading', async () => {
    render(withIntl(await LoginPage({ searchParams: Promise.resolve({}) })));

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
