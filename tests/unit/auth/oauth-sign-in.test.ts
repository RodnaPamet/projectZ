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
const updateMany = jest.fn();
jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({
  // The real one binds app_superuser for the transaction. Sign-in has no tenant
  // to bind yet, which is exactly why it runs as superuser — see auth.ts.
  runAsSuperuser: (fn: (db: unknown) => unknown) => fn({ user: { upsert, update, updateMany } }),
}));
// The copy itself (fetch, resize, store) has its own tests in
// tests/unit/media/avatars.test.ts. Here: what sign-in hands it, and how it saves.
const syncAvatarAtSignIn = jest.fn();
jest.mock('@/lib/media/avatars', () => ({
  syncAvatarAtSignIn: (...args: unknown[]) => syncAvatarAtSignIn(...args),
}));
const STORAGE = { kind: 'local' };
jest.mock('@/lib/media/storage', () => ({ getMediaStorage: () => STORAGE }));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));
// The grant lookup is Graph over the network; its own tests are in
// facebook-permissions.test.ts. Here it only decides which refusal is sent.
const readFacebookEmailPermission = jest.fn();
jest.mock('@/lib/auth/facebook-permissions', () => ({
  readFacebookEmailPermission: (...args: unknown[]) => readFacebookEmailPermission(...args),
}));

import { authOptions } from '@/auth';
import {
  FACEBOOK_EMAIL_REQUIRED_REDIRECT,
  FACEBOOK_EMAIL_UNAVAILABLE_REDIRECT,
} from '@/lib/auth/facebook';
import { NotOurAvatarError } from '@/lib/media/avatar-url';
import { logger } from '@/lib/observability/logger';

type SignInArgs = {
  user: { id?: string; email?: string | null; name?: string | null; image?: string | null };
  account: { type: string; provider: string; access_token?: string } | null;
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
  readFacebookEmailPermission.mockReset();
  readFacebookEmailPermission.mockResolvedValue('unknown');
  upsert.mockReset();
  upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: null });
  update.mockReset();
  update.mockResolvedValue({});
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
  syncAvatarAtSignIn.mockReset();
  syncAvatarAtSignIn.mockResolvedValue(undefined);
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

  describe('which refusal: the grant tells the two causes apart', () => {
    const noEmail = (permission: string): SignInArgs => {
      readFacebookEmailPermission.mockResolvedValue(permission);
      return facebook({
        user: { id: '1029384756', email: null, name: 'Ivo' },
        account: { type: 'oauth', provider: 'facebook', access_token: 'user-token' },
        profile: { id: '1029384756', name: 'Ivo', picture: { data: { url: PICTURE } } },
      });
    };

    it('email ALLOWED and none sent: "Facebook has no address", not "try again"', async () => {
      // The first real sign-in (2026-10-08): "Email address" was shared on the
      // person's Facebook page for the app, and /me still had no address.
      await expect(signIn(noEmail('granted'))).resolves.toBe(FACEBOOK_EMAIL_UNAVAILABLE_REDIRECT);
      expect(readFacebookEmailPermission).toHaveBeenCalledWith('user-token');
      expect(upsert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it.each(['declined', 'not-requested', 'unknown'])(
      '%s: "allow access to your email and try again"',
      async (permission) => {
        await expect(signIn(noEmail(permission))).resolves.toBe(FACEBOOK_EMAIL_REQUIRED_REDIRECT);
        expect(upsert).not.toHaveBeenCalled();
      },
    );

    it('logs the grant and the NAMES of the fields the profile carried, never a value', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await signIn(noEmail('granted'));

        expect(warn).toHaveBeenCalledWith('oauth sign-in refused: the provider returned no email', {
          component: 'auth',
          provider: 'facebook',
          emailPermission: 'granted',
          profileFields: ['id', 'name', 'picture'],
        });
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Ivo|1029384756|user-token|fbsbx/);
      } finally {
        warn.mockRestore();
      }
    });

    it('a Google sign-in without an email asks Facebook nothing', async () => {
      await expect(signIn(google({ user: { id: 'g', email: null } }))).resolves.toBe(false);
      expect(readFacebookEmailPermission).not.toHaveBeenCalled();
    });
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

  it('creates a first sign-in undecided, and never with the provider’s picture URL', async () => {
    await signIn(facebook());

    const [call] = upsert.mock.calls[0] as [{ create: Record<string, unknown> }];
    expect(call.create).toMatchObject({
      email: 'ivo@inflect.bg',
      name: 'Ivo',
      avatarUrl: null,
      accountKind: null,
    });
  });

  describe('the picture is copied into our storage (#458)', () => {
    const KEY = `avatars/cm1appuser0000000000000001/facebook-${'a'.repeat(32)}.webp`;

    it('hands the copy the picture it brought and what is stored', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: EARLIER });
      await signIn(facebook());
      expect(syncAvatarAtSignIn).toHaveBeenCalledWith(
        {
          provider: 'facebook',
          userId: 'app-user-1',
          stored: EARLIER,
          picture: PICTURE,
          save: expect.any(Function),
        },
        STORAGE,
      );
    });

    it('a Google sign-in hands over its picture too', async () => {
      await signIn(google());
      expect(syncAvatarAtSignIn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'google', stored: null, picture: 'https://i/p.png' }),
        STORAGE,
      );
    });

    it('saves only over the value it read, and only our copy or nothing', async () => {
      upsert.mockResolvedValue({ id: 'app-user-1', avatarUrl: GOOGLE_PICTURE });
      await signIn(google());
      const [{ save }] = syncAvatarAtSignIn.mock.calls[0] as [
        { save: (v: string | null) => Promise<boolean> },
      ];

      await expect(save(KEY)).resolves.toBe(true);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'app-user-1', avatarUrl: GOOGLE_PICTURE, deletedAt: null },
        data: { avatarUrl: KEY },
      });
      updateMany.mockResolvedValue({ count: 0 });
      await expect(save(null)).resolves.toBe(false);
      await expect(save(PICTURE)).rejects.toThrow(NotOurAvatarError);
    });

    it('a picture step that fails, even to load, does not fail the sign-in', async () => {
      syncAvatarAtSignIn.mockRejectedValue(new Error('sharp: could not load'));
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const args = facebook();
        await expect(signIn(args)).resolves.toBe(true);
        expect(args.user.id).toBe('app-user-1');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
