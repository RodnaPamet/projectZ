/**
 * @jest-environment node
 */

/**
 * THE SIGN-IN CALLBACK IS THE WHOLE OAUTH PATH NOW.
 *
 * `adapter: PrismaAdapter(prisma)` was removed because it could never have
 * worked: the schema has no `Account`, `Session` or `VerificationToken` model,
 * so the adapter's first call — `prisma.account.findUnique` — threw
 * `Cannot read properties of undefined` on every single OAuth sign-in. The user
 * was redirected back to /login with no message.
 *
 * Nothing caught it because nothing exercised it. The credentials provider does
 * not touch an adapter, and no OAuth provider is even REGISTERED without
 * credentials in the environment — so in CI, in dev and in every test until
 * this one, the broken path did not exist.
 *
 * These tests are that exercise. They call the callback directly with the
 * shapes next-auth passes it.
 */

const upsert = jest.fn();

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({
  // The real one binds app_superuser for the transaction. Sign-in has no tenant
  // to bind yet, which is exactly why it runs as superuser — see auth.ts.
  runAsSuperuser: (fn: (db: unknown) => unknown) => fn({ user: { upsert } }),
}));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));

import { authOptions } from '@/auth';

type SignInArgs = {
  user: { id?: string; email?: string | null; name?: string | null; image?: string | null };
  account: { type: string; provider: string } | null;
  profile?: Record<string, unknown>;
};

const signIn = (args: SignInArgs): Promise<boolean> =>
  (authOptions.callbacks!.signIn as unknown as (a: SignInArgs) => Promise<boolean>)(args);

const google = (over: Partial<SignInArgs> = {}): SignInArgs => ({
  user: { id: 'google-sub-123', email: 'Ivo@Inflect.BG', name: 'Ivo', image: 'https://i/p.png' },
  account: { type: 'oauth', provider: 'google' },
  profile: { email_verified: true },
  ...over,
});

beforeEach(() => {
  upsert.mockReset();
  upsert.mockResolvedValue({ id: 'app-user-1' });
});

describe('oauth sign-in without an adapter', () => {
  it('resolves an app_user and REWRITES user.id to it', async () => {
    // The point of the whole callback. next-auth hands the same object to the
    // jwt callback, which looks up memberships by user.id and writes
    // user_session.userId — a foreign key to app_user. Left as the provider's
    // `sub`, both fail.
    const args = google();
    await expect(signIn(args)).resolves.toBe(true);

    expect(args.user.id).toBe('app-user-1');
  });

  it('lower-cases and trims the email, matching verifyCredentials', async () => {
    // A Google sign-in that created `Ivo@Inflect.BG` while the password path
    // looks up `ivo@inflect.bg` would give one person two accounts, and the
    // second one would own none of their bookings.
    await signIn(google({ user: { email: '  Ivo@Inflect.BG  ' } }));

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'ivo@inflect.bg' } }),
    );
  });

  it('does not overwrite the stored profile on a later sign-in', async () => {
    // `update: {}`. Re-applying the provider's name and avatar every time would
    // silently revert whatever the person changed in the app, on each login.
    await signIn(google());

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it('refuses a Google sign-in whose email is not verified', async () => {
    // Identities are linked BY EMAIL, so a provider that will assert an
    // unproved address is a way into any existing account with that address.
    await expect(signIn(google({ profile: { email_verified: false } }))).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a Google sign-in with no email_verified claim at all', async () => {
    // Absent is not the same as verified. Failing closed costs one sign-in;
    // failing open costs the account.
    await expect(signIn(google({ profile: {} }))).resolves.toBe(false);
    await expect(signIn(google({ profile: undefined }))).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses any oauth sign-in that carries no email', async () => {
    await expect(
      signIn({
        user: { id: 'x', email: null },
        account: { type: 'oauth', provider: 'azure-ad' },
      }),
    ).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not require email_verified from Entra, which never sends it', async () => {
    // A work account's address is controlled by the directory that issued it.
    // Demanding a claim Entra does not emit would refuse every club sign-in.
    await expect(
      signIn({
        user: { id: 'oid-1', email: 'staff@club.bg' },
        account: { type: 'oauth', provider: 'azure-ad' },
        profile: {},
      }),
    ).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('leaves a credentials sign-in completely alone', async () => {
    // authorize() already returned a real app_user. Upserting here would be a
    // second write on every password login, and would resurrect a user whose
    // row had just been deleted.
    const args: SignInArgs = {
      user: { id: 'app-user-9', email: 'ivo@inflect.bg' },
      account: { type: 'credentials', provider: 'credentials' },
    };
    await expect(signIn(args)).resolves.toBe(true);

    expect(upsert).not.toHaveBeenCalled();
    expect(args.user.id).toBe('app-user-9');
  });
});
