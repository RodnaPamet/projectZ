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
const update = jest.fn();

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({
  // The real one binds app_superuser for the transaction. Sign-in has no tenant
  // to bind yet, which is exactly why it runs as superuser — see auth.ts.
  runAsSuperuser: (fn: (db: unknown) => unknown) => fn({ user: { upsert, update } }),
}));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));

import { authOptions } from '@/auth';
import { FACEBOOK_EMAIL_REQUIRED_REDIRECT } from '@/lib/auth/facebook';

type SignInArgs = {
  user: { id?: string; email?: string | null; name?: string | null; image?: string | null };
  account: { type: string; provider: string } | null;
  profile?: Record<string, unknown>;
};

const signIn = (args: SignInArgs): Promise<boolean | string> =>
  (authOptions.callbacks!.signIn as unknown as (a: SignInArgs) => Promise<boolean | string>)(args);

const google = (over: Partial<SignInArgs> = {}): SignInArgs => ({
  user: { id: 'google-sub-123', email: 'Ivo@Inflect.BG', name: 'Ivo', image: 'https://i/p.png' },
  account: { type: 'oauth', provider: 'google' },
  profile: { email_verified: true },
  ...over,
});

beforeEach(() => {
  upsert.mockReset();
  upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: null });
  update.mockReset();
  update.mockResolvedValue({});
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

  it('creates a first sign-in UNDECIDED (#360), and never re-kinds an existing one (#263)', async () => {
    // A new account has not chosen player or coach yet: `/start` asks it
    // first (#360). Its kind is set by that choice, a staff invite or being
    // made an owner, never by signing in, which is why the kind is in
    // `create` and not in `update`.
    await signIn(google());

    const [args] = upsert.mock.calls[0] as [
      { create: Record<string, unknown>; update: Record<string, unknown> },
    ];
    expect(args.create.accountKind).toBeNull();
    expect(args.update).toEqual({});
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
      signIn(google({ user: { id: 'x', email: null }, profile: { email_verified: true } })),
    ).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
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

describe('Facebook sign-in (#361)', () => {
  const PICTURE =
    'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1029&height=50&width=50&ext=1790000000&hash=AbC';
  const EARLIER =
    'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1029&height=50&width=50&ext=1780000000&hash=XyZ';
  const GOOGLE_PICTURE = 'https://lh3.googleusercontent.com/a/ACg8ocK';

  const facebook = (over: Partial<SignInArgs> = {}): SignInArgs => ({
    user: { id: '1029384756', email: 'Ivo@Inflect.BG', name: 'Ivo', image: PICTURE },
    account: { type: 'oauth', provider: 'facebook' },
    profile: {
      id: '1029384756',
      name: 'Ivo',
      email: 'Ivo@Inflect.BG',
      picture: { data: { url: PICTURE, is_silhouette: false } },
    },
    ...over,
  });

  it('with no email: writes nothing, and sends the person to the explanation', async () => {
    // Accounts are found by email. An account made without one could never be
    // found again; the next sign-in would make another.
    await expect(signIn(facebook({ user: { id: '1029384756', email: null } }))).resolves.toBe(
      FACEBOOK_EMAIL_REQUIRED_REDIRECT,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses through next-auth’s sign-in route, which carries the callback URL to /login', () => {
    // Returning `false` would land on /login?error=AccessDenied with the
    // destination dropped — an invitation lost on the refusal.
    expect(FACEBOOK_EMAIL_REQUIRED_REDIRECT).toBe('/api/auth/signin?error=FacebookEmailRequired');
  });

  it.each(['', '   '])('treats %j as no email', async (email) => {
    await expect(signIn(facebook({ user: { id: '1', email } }))).resolves.toBe(
      FACEBOOK_EMAIL_REQUIRED_REDIRECT,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('links by email as Google does, with no email_verified claim to ask for', async () => {
    // Facebook sends none. Linking relies on it releasing confirmed addresses
    // only — the trade #361 states, in src/auth.ts.
    const args = facebook();
    await expect(signIn(args)).resolves.toBe(true);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'ivo@inflect.bg' }, update: {} }),
    );
    expect(args.user.id).toBe('app-user-1');
    expect(args.user.email).toBe('ivo@inflect.bg');
  });

  it('creates a first sign-in undecided, with the picture it brought', async () => {
    await signIn(facebook());

    const [call] = upsert.mock.calls[0] as [{ create: Record<string, unknown> }];
    expect(call.create).toMatchObject({
      email: 'ivo@inflect.bg',
      name: 'Ivo',
      avatarUrl: PICTURE,
      accountKind: null,
    });
  });

  describe('the picture is a signed URL that expires, so each Facebook sign-in re-reads it', () => {
    it('writes nothing more when the stored picture is the one just brought', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: PICTURE });
      await signIn(facebook());
      expect(update).not.toHaveBeenCalled();
    });

    it('replaces an earlier Facebook picture', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: EARLIER });
      await signIn(facebook());
      expect(update).toHaveBeenCalledWith({
        where: { id: 'app-user-1' },
        data: { avatarUrl: PICTURE },
      });
    });

    it('fills an account that has no picture', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: null });
      await signIn(facebook());
      expect(update).toHaveBeenCalledWith({
        where: { id: 'app-user-1' },
        data: { avatarUrl: PICTURE },
      });
    });

    it('never replaces a picture from anywhere else', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: GOOGLE_PICTURE });
      await signIn(facebook());
      expect(update).not.toHaveBeenCalled();
    });

    it('a silhouette clears an earlier Facebook picture, so the initials show', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: EARLIER });
      await signIn(facebook({ user: { id: '1029384756', email: 'ivo@inflect.bg', image: null } }));
      expect(update).toHaveBeenCalledWith({
        where: { id: 'app-user-1' },
        data: { avatarUrl: null },
      });
    });

    it('a refresh that fails does not fail the sign-in', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: EARLIER });
      update.mockRejectedValue(new Error('connection reset'));

      const args = facebook();
      await expect(signIn(args)).resolves.toBe(true);
      expect(args.user.id).toBe('app-user-1');
    });
  });

  it('a Google sign-in never touches the picture, whatever it is', async () => {
    upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: EARLIER });
    await signIn(google());
    expect(update).not.toHaveBeenCalled();
  });
});
