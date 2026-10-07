import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signIn } from 'next-auth/react';

import { LoginForm } from '@/app/(public)/login/login-form';

import { enMessages, messages, withIntl } from '../helpers/intl';

/**
 * Web sign-in is Google or Facebook (#361, Q15/Q21). There is no password form.
 *
 * ═══ WHAT THESE ARE ACTUALLY GUARDING ═══
 *
 * The owner's decision is that everyone signs in with Google or Facebook, so
 * the identity provider owns recovery, MFA and revocation rather than this
 * app. A reinstated email/password field would quietly undo that, and nothing
 * else in the suite would notice.
 *
 * Email and password exist for the test suites only, which sign in
 * programmatically (`@/lib/auth/password-sign-in`), never through this form.
 *
 * And Facebook's refusal when it sends no email address (`?error=
 * FacebookEmailRequired`) is explained, with a way to ask again and the
 * Google button still there — pinned below by what `signIn` receives.
 */
jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

const BOTH = { error: null, callbackUrl: '/start', google: true, facebook: true };

beforeEach(() => jest.mocked(signIn).mockReset());

describe('LoginForm', () => {
  it('offers Google and Facebook, each with its own mark', () => {
    render(withIntl(<LoginForm {...BOTH} />));

    const google = screen.getByRole('button', { name: messages.login.withGoogle });
    const facebook = screen.getByRole('button', { name: messages.login.withFacebook });
    // The brand marks, not decoration: each provider's rules ask for its logo
    // on the button.
    expect(google.querySelector('svg')).not.toBeNull();
    expect(facebook.querySelector('svg')).not.toBeNull();
    // Meta's Login button colour for the "f" mark, unmodified.
    expect(facebook.querySelector('circle')).toHaveAttribute('fill', '#1877F2');
  });

  it('labels the Facebook button "Вход с Facebook", and as Meta words it in English', () => {
    render(withIntl(<LoginForm {...BOTH} />));
    expect(screen.getByRole('button', { name: 'Вход с Facebook' })).toBeInTheDocument();

    render(withIntl(<LoginForm {...BOTH} />, 'en'));
    expect(screen.getByRole('button', { name: 'Log in with Facebook' })).toBeInTheDocument();
    expect(enMessages.login.withFacebook).toBe('Log in with Facebook');
  });

  it('sends Facebook to next-auth by its provider id, with the destination', async () => {
    // `facebook` is what next-auth builds the redirect URI from:
    // /api/auth/callback/facebook, the exact string registered with Meta.
    render(withIntl(<LoginForm {...BOTH} callbackUrl="/invite/abc" />));
    await userEvent.click(screen.getByRole('button', { name: messages.login.withFacebook }));

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith('facebook', { callbackUrl: '/invite/abc' }, undefined);
  });

  it('has NO password or email field', () => {
    const { container } = render(withIntl(<LoginForm {...BOTH} />));

    // By query rather than by label, so a renamed label cannot hide a
    // reinstated field.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  it('offers nothing from Microsoft any more', () => {
    const { container } = render(withIntl(<LoginForm {...BOTH} />));

    expect(container.textContent).not.toMatch(/Microsoft/i);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it.each([
    ['google', { ...BOTH, google: false }, messages.login.withFacebook, messages.login.withGoogle],
    [
      'facebook',
      { ...BOTH, facebook: false },
      messages.login.withGoogle,
      messages.login.withFacebook,
    ],
  ])('hides the %s button when it is not configured', (_name, props, shown, hidden) => {
    // An unconfigured provider is not registered by src/auth.ts, so its button
    // would lead to a next-auth error page for an unknown provider. Not
    // rendering it is the whole point of passing these flags down.
    render(withIntl(<LoginForm {...props} />));

    expect(screen.getByRole('button', { name: shown })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: hidden })).toBeNull();
  });

  it('says so when no provider is configured, rather than showing an empty card', () => {
    render(withIntl(<LoginForm error={null} callbackUrl="/" google={false} facebook={false} />));

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent(messages.login.noProviders);
  });

  it('is a level-one heading, and every colour is a theme token', () => {
    // `text-muted-foreground` and `text-destructive` are shadcn names this
    // theme never defined: the subtitle and the error both rendered in the
    // inherited body colour, so a failed sign-in looked like the subtitle.
    const { container } = render(withIntl(<LoginForm {...BOTH} error="OAuthSignin" />));

    expect(screen.getByRole('heading', { level: 1, name: messages.login.title })).toBeVisible();
    expect(screen.getByText(messages.login.subtitle)).toHaveClass('text-content-muted');
    // The error is the error notice — its own token colour, not body text.
    expect(screen.getByRole('alert')).toHaveClass('text-content-error');
    expect(container.innerHTML).not.toMatch(/muted-foreground|text-destructive/);
  });

  it.each(['OAuthAccountNotLinked', 'AccessDenied', 'CredentialsSignin', 'Callback'])(
    'never puts a raw next-auth code on screen: %s',
    (code) => {
      render(withIntl(<LoginForm {...BOTH} error={code} />));

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(messages.login.unavailable);
      expect(alert.textContent).not.toContain(code);
    },
  );
});

describe('LoginForm — Facebook sent no email address (#361)', () => {
  const REFUSED = { ...BOTH, error: 'FacebookEmailRequired', callbackUrl: '/invite/abc' };

  it('explains why, in words, instead of the generic message', () => {
    render(withIntl(<LoginForm {...REFUSED} />));

    const notice = screen.getByTestId('login-facebook-email-required');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent(messages.login.facebookEmail.title);
    expect(notice).toHaveTextContent(messages.login.facebookEmail.body);
    expect(screen.queryByText(messages.login.unavailable)).toBeNull();
    expect(notice.textContent).not.toContain('FacebookEmailRequired');
  });

  it('turns the Facebook button into "try again", which asks Meta for the permission again', async () => {
    // Without auth_type=rerequest the Login Dialog does not offer a declined
    // permission a second time, and "try again" would refuse again.
    render(withIntl(<LoginForm {...REFUSED} />));

    expect(screen.queryByRole('button', { name: messages.login.withFacebook })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: messages.login.facebookEmail.retry }));

    expect(signIn).toHaveBeenCalledWith(
      'facebook',
      { callbackUrl: '/invite/abc' },
      { auth_type: 'rerequest' },
    );
  });

  it('keeps Google beside it, pointing the same way', async () => {
    render(withIntl(<LoginForm {...REFUSED} />));

    expect(
      within(screen.getByTestId('login-facebook-email-required')).getByText(
        messages.login.facebookEmail.googleHint,
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: messages.login.withGoogle }));

    expect(signIn).toHaveBeenCalledWith('google', { callbackUrl: '/invite/abc' }, undefined);
  });

  it('does not point at Google where Google is not configured', () => {
    render(withIntl(<LoginForm {...REFUSED} google={false} />));

    expect(screen.queryByText(messages.login.facebookEmail.googleHint)).toBeNull();
    expect(screen.getByRole('button', { name: messages.login.facebookEmail.retry })).toBeVisible();
  });

  it('falls back to the generic message if Facebook is no longer offered', () => {
    // The explanation ends in "try again"; without the button it would be a
    // promise the page cannot keep.
    render(withIntl(<LoginForm {...REFUSED} facebook={false} />));

    expect(screen.queryByTestId('login-facebook-email-required')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(messages.login.unavailable);
  });
});
