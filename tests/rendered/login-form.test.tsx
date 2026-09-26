import { render, screen } from '@testing-library/react';

import { LoginForm } from '@/app/(public)/login/login-form';

import { withIntl } from '../helpers/intl';

/**
 * Web sign-in is Google or Microsoft. There is no password form.
 *
 * ═══ WHAT THESE ARE ACTUALLY GUARDING ═══
 *
 * The owner's decision is that the web offers federated sign-in only, so the
 * identity provider owns recovery, MFA and revocation rather than this app.
 * A reinstated email/password field would quietly undo that, and nothing else
 * in the suite would notice — this component had NO test at all before.
 *
 * The credentials PROVIDER is deliberately still registered in `src/auth.ts`:
 * `POST /api/v1/auth/token` is the native client's only way in until the iOS
 * app has an ASWebAuthenticationSession flow (#167). Removing the form is not
 * the same as removing the provider, and these tests pin the form only.
 */
jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

const BOTH = { error: null, callbackUrl: '/', google: true, microsoft: true };

describe('LoginForm', () => {
  it('offers Google and Microsoft', () => {
    render(withIntl(<LoginForm {...BOTH} />));

    expect(screen.getByRole('button', { name: /Google/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Microsoft/i })).toBeInTheDocument();
  });

  it('has NO password or email field', () => {
    const { container } = render(withIntl(<LoginForm {...BOTH} />));

    // By query rather than by label, so a renamed label cannot hide a
    // reinstated field.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  it.each([
    ['google', { ...BOTH, google: false }, /Microsoft/i, /Google/i],
    ['microsoft', { ...BOTH, microsoft: false }, /Google/i, /Microsoft/i],
  ])('hides the %s button when it is not configured', (_name, props, shown, hidden) => {
    // An unconfigured provider is not registered by src/auth.ts, so its button
    // would lead to a next-auth error page for an unknown provider. Not
    // rendering it is the whole point of passing these flags down.
    render(withIntl(<LoginForm {...props} />));

    expect(screen.getByRole('button', { name: shown })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: hidden })).toBeNull();
  });

  it('says so when no provider is configured, rather than showing an empty card', () => {
    render(withIntl(<LoginForm error={null} callbackUrl="/" google={false} microsoft={false} />));

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('still maps CredentialsSignin, because the endpoint that produces it is live', () => {
    // Nothing on this page can produce that code any more. The native token
    // route can, and next-auth routes its errors here — a raw error code on
    // screen is worse than one line of mapping for a case the web cannot hit.
    render(withIntl(<LoginForm {...BOTH} error="CredentialsSignin" />));

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).not.toMatch(/CredentialsSignin/);
  });

  it('does not leak a raw next-auth error code for anything else either', () => {
    render(withIntl(<LoginForm {...BOTH} error="OAuthAccountNotLinked" />));

    expect(screen.getByRole('alert').textContent).not.toMatch(/OAuth/);
  });
});
