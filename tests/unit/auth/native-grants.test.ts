/**
 * @jest-environment node
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

import { createHash } from 'node:crypto';

import {
  NativeGrantError,
  verifyAppleIdToken,
  verifyFacebookAccessToken,
  verifyFacebookIdToken,
  verifyGoogleIdToken,
} from '@/lib/auth/native-grants';

/**
 * A NATIVE PROVIDER TOKEN IS BELIEVED ONLY WHEN THE PROVIDER VOUCHES FOR IT,
 * AND ONLY WHEN IT WAS MINTED FOR THIS APP (#444).
 *
 * The keys here are made for the test, so every rule is exercised against a
 * real signature: a token from another key, for another audience, from
 * another issuer, expired, or with no signature at all is refused the same
 * way, and only a provider that did not answer is a retryable 503.
 */

const IOS_CLIENT = 'ios-client.apps.googleusercontent.com';
const FB_APP = '28557453233922839';

let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  keys = createLocalJWKSet({ keys: [jwk] });
  strangerKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
});

async function sign(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? IOS_CLIENT)
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? privateKey);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof NativeGrantError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const google = (token: string, audiences = [IOS_CLIENT]) =>
  verifyGoogleIdToken(token, { audiences, keys });

describe('verifyGoogleIdToken', () => {
  it('returns the person, address lower-cased, proved when email_verified is true', async () => {
    const token = await sign({
      email: ' Petya@Example.BG ',
      email_verified: true,
      name: 'Петя Иванова',
      picture: 'https://lh3.googleusercontent.com/a/x',
    });
    await expect(google(token)).resolves.toEqual({
      provider: 'google',
      email: 'petya@example.bg',
      emailVerified: true,
      name: 'Петя Иванова',
      picture: 'https://lh3.googleusercontent.com/a/x',
    });
  });

  it('accepts the issuer without its scheme, which Google also sends', async () => {
    const token = await sign(
      { email: 'a@b.bg', email_verified: true },
      { iss: 'accounts.google.com' },
    );
    await expect(google(token)).resolves.toMatchObject({ email: 'a@b.bg' });
  });

  it.each([
    ['false', false],
    ['absent', undefined],
    ['the string "true"', 'true'],
  ])('is not proved when email_verified is %s', async (_label, value) => {
    const token = await sign({
      email: 'a@b.bg',
      ...(value === undefined ? {} : { email_verified: value }),
    });
    await expect(google(token)).resolves.toMatchObject({ emailVerified: false });
  });

  it('accepts any of several app clients', async () => {
    const token = await sign({ email: 'a@b.bg', email_verified: true }, { aud: 'android-client' });
    await expect(google(token, [IOS_CLIENT, 'android-client'])).resolves.toMatchObject({
      email: 'a@b.bg',
    });
  });

  it.each([
    [
      'addressed to another app (the web client, say)',
      { aud: 'web-client.apps.googleusercontent.com' },
    ],
    ['from another issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ])('refuses a token %s', async (_label, opts) => {
    const token = await sign({ email: 'a@b.bg', email_verified: true }, opts);
    expect(await codeOf(google(token))).toBe('INVALID_PROVIDER_TOKEN');
  });

  it('refuses a token signed by a key that is not the provider’s', async () => {
    const token = await sign({ email: 'a@b.bg', email_verified: true }, { key: strangerKey });
    expect(await codeOf(google(token))).toBe('INVALID_PROVIDER_TOKEN');
  });

  it('refuses an unsigned token and one that is not a token at all', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ iss: 'https://accounts.google.com', aud: IOS_CLIENT, email: 'a@b.bg' }),
    ).toString('base64url');
    expect(await codeOf(google(`${header}.${body}.`))).toBe('INVALID_PROVIDER_TOKEN');
    expect(await codeOf(google('not-a-jwt'))).toBe('INVALID_PROVIDER_TOKEN');
  });

  it('is disabled when no app client is configured, before looking at the token', async () => {
    expect(await codeOf(verifyGoogleIdToken('anything', { audiences: [], keys }))).toBe(
      'SIGN_IN_METHOD_DISABLED',
    );
  });

  it('is a retryable 503 when the key set could not be read', async () => {
    const token = await sign({ email: 'a@b.bg', email_verified: true });
    const unreachable: JWTVerifyGetKey = async () => {
      throw new TypeError('fetch failed');
    };
    expect(
      await codeOf(verifyGoogleIdToken(token, { audiences: [IOS_CLIENT], keys: unreachable })),
    ).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('verifyFacebookIdToken (Limited Login)', () => {
  const fb = (claims: Record<string, unknown>, opts: { aud?: string } = {}) =>
    sign(claims, { iss: 'https://www.facebook.com', aud: opts.aud ?? FB_APP });

  it('returns the person; a present address is taken as proved, as on the web', async () => {
    const token = await fb({ email: 'Ivo@Example.bg', name: 'Иво', picture: 'https://x/p.jpg' });
    await expect(verifyFacebookIdToken(token, { appId: FB_APP, keys })).resolves.toEqual({
      provider: 'facebook',
      email: 'ivo@example.bg',
      emailVerified: true,
      name: 'Иво',
      picture: 'https://x/p.jpg',
    });
  });

  it('returns no address when the person did not share one', async () => {
    const token = await fb({ name: 'Иво' });
    await expect(verifyFacebookIdToken(token, { appId: FB_APP, keys })).resolves.toMatchObject({
      email: null,
      emailVerified: false,
    });
  });

  it('refuses a token minted for another Facebook app', async () => {
    const token = await fb({ email: 'a@b.bg' }, { aud: '999' });
    expect(await codeOf(verifyFacebookIdToken(token, { appId: FB_APP, keys }))).toBe(
      'INVALID_PROVIDER_TOKEN',
    );
  });

  it('checks the nonce when the app sends one', async () => {
    const token = await fb({ email: 'a@b.bg', nonce: 'n-1' });
    await expect(
      verifyFacebookIdToken(token, { appId: FB_APP, nonce: 'n-1', keys }),
    ).resolves.toMatchObject({ email: 'a@b.bg' });
    expect(await codeOf(verifyFacebookIdToken(token, { appId: FB_APP, nonce: 'n-2', keys }))).toBe(
      'INVALID_PROVIDER_TOKEN',
    );
  });

  it('is disabled without an app id', async () => {
    expect(await codeOf(verifyFacebookIdToken('x', { appId: '', keys }))).toBe(
      'SIGN_IN_METHOD_DISABLED',
    );
  });
});

describe('verifyFacebookAccessToken (Facebook Login)', () => {
  const SECRET = 'app-secret'; // pragma: allowlist secret

  /** Graph, as far as these two calls go. */
  function graph(
    debug: Record<string, unknown> | { status: number },
    me: Record<string, unknown> | { status: number } = {
      id: '42',
      name: 'Петя',
      email: 'Petya@Example.bg',
      picture: {
        data: { url: 'https://platform-lookaside.fbsbx.com/p.jpg', is_silhouette: false },
      },
    },
  ) {
    const calls: Array<{ url: URL; auth: string | null }> = [];
    const reply = (body: Record<string, unknown> | { status: number }) =>
      'status' in body && typeof body.status === 'number' && Object.keys(body).length === 1
        ? new Response('{}', { status: body.status })
        : new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return url.pathname.endsWith('/debug_token') ? reply(debug) : reply(me);
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  const valid = { data: { is_valid: true, app_id: FB_APP, type: 'USER', user_id: '42' } };
  const verify = (fetchImpl: typeof fetch) =>
    verifyFacebookAccessToken('user-token', { appId: FB_APP, appSecret: SECRET, fetch: fetchImpl });

  it('asks Graph whether the token is ours, then reads that person', async () => {
    const { calls, fetchImpl } = graph(valid);
    await expect(verify(fetchImpl)).resolves.toEqual({
      provider: 'facebook',
      email: 'petya@example.bg',
      emailVerified: true,
      name: 'Петя',
      picture: 'https://platform-lookaside.fbsbx.com/p.jpg',
    });

    const [debug, me] = calls;
    // debug_token: asked with the APP's token; the person's is the subject.
    expect(debug.url.pathname).toBe('/v26.0/debug_token');
    expect(debug.url.searchParams.get('input_token')).toBe('user-token');
    expect(debug.auth).toBe(`Bearer ${FB_APP}|${SECRET}`);
    // /me: the person's token in the header, with the proof Graph may demand.
    expect(me.url.pathname).toBe('/v26.0/me');
    expect(me.auth).toBe('Bearer user-token');
    expect(me.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(me.url.searchParams.get('access_token')).toBeNull();
  });

  it.each([
    ['minted for another app', { data: { ...valid.data, app_id: '999' } }],
    ['no longer valid', { data: { ...valid.data, is_valid: false } }],
    ['an app token, not a person’s', { data: { ...valid.data, type: 'APP' } }],
    ['without a user', { data: { ...valid.data, user_id: undefined } }],
    ['answered with no data', {}],
  ])('refuses a token %s, without reading anybody', async (_label, debug) => {
    const { calls, fetchImpl } = graph(debug);
    expect(await codeOf(verify(fetchImpl))).toBe('INVALID_PROVIDER_TOKEN');
    expect(calls).toHaveLength(1);
  });

  it('refuses when /me is somebody other than the token’s person', async () => {
    const { fetchImpl } = graph(valid, { id: '43', email: 'x@y.bg' });
    expect(await codeOf(verify(fetchImpl))).toBe('INVALID_PROVIDER_TOKEN');
  });

  it('a 4xx from Graph is the token; a 5xx or no answer is Graph', async () => {
    expect(await codeOf(verify(graph({ status: 400 }).fetchImpl))).toBe('INVALID_PROVIDER_TOKEN');
    expect(await codeOf(verify(graph({ status: 503 }).fetchImpl))).toBe('PROVIDER_UNAVAILABLE');
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await codeOf(verify(down))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('keeps no silhouette and returns no address when Facebook gave none', async () => {
    const { fetchImpl } = graph(valid, {
      id: '42',
      name: 'Петя',
      picture: { data: { url: 'https://x/s.jpg', is_silhouette: true } },
    });
    await expect(verify(fetchImpl)).resolves.toMatchObject({
      email: null,
      emailVerified: false,
      picture: null,
    });
  });

  it('is disabled without both halves of the app’s pair', async () => {
    const { calls, fetchImpl } = graph(valid);
    expect(
      await codeOf(
        verifyFacebookAccessToken('t', { appId: FB_APP, appSecret: '', fetch: fetchImpl }),
      ),
    ).toBe('SIGN_IN_METHOD_DISABLED');
    expect(calls).toHaveLength(0);
  });
});

describe('verifyAppleIdToken (#442)', () => {
  const BUNDLE = 'bg.playerz.app';
  const apple = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}) =>
    sign(
      { sub: '001234.abcdef.1200', ...claims },
      { iss: opts.iss ?? 'https://appleid.apple.com', aud: opts.aud ?? BUNDLE },
    );
  const verify = (token: string, nonce?: string) =>
    verifyAppleIdToken(token, { audiences: [BUNDLE], keys, ...(nonce ? { nonce } : {}) });

  it('returns the Apple ID and a real address; Apple sends its booleans as strings too', async () => {
    const token = await apple({
      email: 'Petya@Example.bg',
      email_verified: 'true',
      is_private_email: 'false',
    });
    await expect(verify(token)).resolves.toEqual({
      provider: 'apple',
      email: 'petya@example.bg',
      emailVerified: true,
      name: null,
      picture: null,
      subject: '001234.abcdef.1200',
      privateEmail: false,
    });
  });

  it('marks the relay address private, by the claim or by its domain', async () => {
    const byClaim = await apple({
      email: 'x1@privaterelay.appleid.com',
      email_verified: true,
      is_private_email: true,
    });
    const byDomain = await apple({ email: 'x2@privaterelay.appleid.com', email_verified: true });
    await expect(verify(byClaim)).resolves.toMatchObject({ privateEmail: true });
    await expect(verify(byDomain)).resolves.toMatchObject({ privateEmail: true });
  });

  it("checks the nonce against Apple's SHA-256 of it", async () => {
    const raw = 'raw-nonce-from-the-app';
    const token = await apple({ nonce: createHash('sha256').update(raw).digest('hex') });
    await expect(verify(token, raw)).resolves.toMatchObject({ subject: '001234.abcdef.1200' });
    expect(await codeOf(verify(token, 'another'))).toBe('INVALID_PROVIDER_TOKEN');
  });

  it.each([
    ['for another app', { aud: 'com.example.other' }],
    ['from another issuer', { iss: 'https://accounts.google.com' }],
  ])('refuses a token %s', async (_label, opts) => {
    expect(await codeOf(verify(await apple({ email: 'a@b.bg' }, opts)))).toBe(
      'INVALID_PROVIDER_TOKEN',
    );
  });

  it('is disabled when no client id is configured', async () => {
    expect(await codeOf(verifyAppleIdToken('x', { audiences: [], keys }))).toBe(
      'SIGN_IN_METHOD_DISABLED',
    );
  });
});
