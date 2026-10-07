/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto';

import type { NextAuthOptions } from 'next-auth';

import {
  FACEBOOK_GRAPH_VERSION,
  facebookPictureFrom,
  facebookRefreshesAvatar,
  isFacebookPictureUrl,
} from '@/lib/auth/facebook';

/**
 * FACEBOOK LOGIN, AS NEXT-AUTH ACTUALLY BUILDS IT (#361).
 *
 * The authorization URL is read off next-auth's own sign-in handler — the code
 * a real "Вход с Facebook" click runs — rather than off our options object,
 * because next-auth MERGES our overrides into the provider's defaults at
 * request time. A typo'd key in the override is silently ignored, and the
 * default it fails to replace is Graph v11.0, retired in 2023.
 *
 * Meta registers the redirect URI in strict mode, so these pin it exactly for
 * every host the app is reached on.
 */

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));

const KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'FACEBOOK_CLIENT_ID',
  'FACEBOOK_CLIENT_SECRET',
  'NEXTAUTH_URL',
] as const;

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const k of KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/** `src/auth.ts`, evaluated afresh: its provider list is decided at load. */
function loadAuthOptions(): NextAuthOptions {
  let options: NextAuthOptions | undefined;
  jest.isolateModules(() => {
    options = (require('@/auth') as typeof import('@/auth')).authOptions;
  });
  return options!;
}

/**
 * POST /api/auth/signin/facebook through next-auth's own handler, with a valid
 * CSRF pair, exactly as `signIn('facebook', …)` sends it. Returns the URL the
 * browser is sent to.
 */
async function facebookDialogUrl(origin: string, query: Record<string, string> = {}): Promise<URL> {
  process.env.NEXTAUTH_URL = origin;
  process.env.FACEBOOK_CLIENT_ID = '1234567890123456';
  process.env.FACEBOOK_CLIENT_SECRET = 'meta-app-secret'; // pragma: allowlist secret
  const options = loadAuthOptions();

  let NextAuth: (...args: unknown[]) => Promise<unknown>;
  jest.isolateModules(() => {
    NextAuth = (require('next-auth') as { default: typeof NextAuth }).default;
  });

  const secret = process.env.NEXTAUTH_SECRET!;
  const csrf = 'unit-test-csrf-token';
  const hash = createHash('sha256').update(`${csrf}${secret}`).digest('hex');
  const cookie = `${origin.startsWith('https:') ? '__Host-' : ''}next-auth.csrf-token`;

  let body: { url?: string } = {};
  const headers = new Map<string, unknown>();
  const res = {
    status: () => res,
    setHeader: (k: string, v: unknown) => (headers.set(k.toLowerCase(), v), res),
    getHeader: (k: string) => headers.get(k.toLowerCase()),
    json: (b: { url?: string }) => {
      body = b;
    },
    send: () => undefined,
    end: () => undefined,
  };
  const req = {
    method: 'POST',
    query: { nextauth: ['signin', 'facebook'], ...query },
    body: { csrfToken: csrf, callbackUrl: '/invite/abc', json: 'true' },
    cookies: { [cookie]: `${csrf}|${hash}` },
    headers: { host: new URL(origin).host },
  };

  await NextAuth!(req, res, options);
  if (!body.url) throw new Error(`no redirect from next-auth: ${JSON.stringify(body)}`);
  return new URL(body.url);
}

describe('the Facebook provider (#361)', () => {
  it('is registered as `facebook`, and only when BOTH halves are set', () => {
    process.env.FACEBOOK_CLIENT_ID = 'id';
    expect(loadAuthOptions().providers.map((p) => p.id)).not.toContain('facebook');

    process.env.FACEBOOK_CLIENT_SECRET = 'secret'; // pragma: allowlist secret
    expect(loadAuthOptions().providers.map((p) => p.id)).toContain('facebook');
  });

  it(`sends people to the ${FACEBOOK_GRAPH_VERSION} Login Dialog, not next-auth's retired v11.0`, async () => {
    const url = await facebookDialogUrl('https://playerz.bg');

    expect(`${url.origin}${url.pathname}`).toBe(
      `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`,
    );
    expect(url.pathname).not.toContain('v11.0');
  });

  it('asks for email and public_profile, with the app id and a state', async () => {
    const url = await facebookDialogUrl('https://playerz.bg');

    expect(url.searchParams.get('scope')?.split(/[ ,]+/).sort()).toEqual([
      'email',
      'public_profile',
    ]);
    expect(url.searchParams.get('client_id')).toBe('1234567890123456');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
    // The secret is for the token exchange, server to server. Never the browser.
    expect(url.toString()).not.toContain('meta-app-secret');
  });

  // The three hosts registered with the Meta app (docs/oauth-setup.md):
  // production, the old production origin while it redirects, and staging.
  it.each([
    ['https://playerz.bg', 'https://playerz.bg/api/auth/callback/facebook'],
    ['https://app.playerz.bg', 'https://app.playerz.bg/api/auth/callback/facebook'],
    ['https://staging.playerz.bg', 'https://staging.playerz.bg/api/auth/callback/facebook'],
  ])(
    'with NEXTAUTH_URL=%s the redirect_uri is exactly the one registered with Meta',
    async (origin, registered) => {
      const url = await facebookDialogUrl(origin);
      expect(url.searchParams.get('redirect_uri')).toBe(registered);
    },
  );

  it('"try again" re-requests the declined permission', async () => {
    const url = await facebookDialogUrl('https://playerz.bg', { auth_type: 'rerequest' });

    expect(url.searchParams.get('auth_type')).toBe('rerequest');
    expect(url.searchParams.get('scope')).toContain('email');
  });

  it('reads the profile defensively, and never takes a silhouette for a picture', () => {
    process.env.FACEBOOK_CLIENT_ID = 'id';
    process.env.FACEBOOK_CLIENT_SECRET = 'secret'; // pragma: allowlist secret
    const provider = loadAuthOptions().providers.find((p) => p.id === 'facebook') as unknown as {
      options: { profile: (p: Record<string, unknown>) => Record<string, unknown> };
    };
    const profile = provider.options.profile;

    expect(
      profile({
        id: '1029',
        name: 'Иво',
        email: 'ivo@example.bg',
        picture: {
          data: { url: 'https://platform-lookaside.fbsbx.com/p?x=1', is_silhouette: false },
        },
      }),
    ).toEqual({
      id: '1029',
      name: 'Иво',
      email: 'ivo@example.bg',
      image: 'https://platform-lookaside.fbsbx.com/p?x=1',
    });
    // next-auth's own profile() throws on a missing picture, and next-auth
    // turns that throw into a silent bounce to /login.
    expect(profile({ id: '1029', name: 'Иво' })).toEqual({
      id: '1029',
      name: 'Иво',
      email: null,
      image: null,
    });
    expect(
      profile({
        id: '7',
        picture: { data: { url: 'https://x.fbcdn.net/s.jpg', is_silhouette: true } },
      }).image,
    ).toBeNull();
  });
});

describe('Facebook pictures are loans, not avatars', () => {
  it.each([
    ['https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1&ext=2&hash=3', true],
    ['https://scontent.xx.fbcdn.net/v/t1.30497-1/84628273_n.jpg', true],
    ['https://lh3.googleusercontent.com/a/ACg8ocK', false],
    // A lookalike host is not Facebook's.
    ['https://fbcdn.net.evil.example/p.jpg', false],
    ['https://evilfbsbx.com/p.jpg', false],
    ['not a url', false],
    [null, false],
  ])('%s is Facebook-issued: %s', (url, expected) => {
    expect(isFacebookPictureUrl(url)).toBe(expected);
  });

  it('a Facebook sign-in refreshes only an empty avatar or an earlier Facebook one', () => {
    expect(facebookRefreshesAvatar(null)).toBe(true);
    expect(facebookRefreshesAvatar('https://platform-lookaside.fbsbx.com/old')).toBe(true);
    expect(facebookRefreshesAvatar('https://lh3.googleusercontent.com/a/x')).toBe(false);
  });

  it.each([
    [
      { picture: { data: { url: 'https://x.fbcdn.net/a.jpg', is_silhouette: false } } },
      'https://x.fbcdn.net/a.jpg',
    ],
    [{ picture: { data: { url: 'https://x.fbcdn.net/a.jpg', is_silhouette: true } } }, null],
    [{ picture: { data: { url: 'http://x.fbcdn.net/a.jpg' } } }, null],
    [{ picture: {} }, null],
    [{}, null],
    [null, null],
  ])('reads the picture from %j as %s', (profile, expected) => {
    expect(facebookPictureFrom(profile)).toBe(expected);
  });
});
