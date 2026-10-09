/**
 * @jest-environment node
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import { FACEBOOK_USERINFO_FIELDS } from '@/lib/auth/facebook';
import { purgeAvatarObjects, sweepOrphanAvatars } from '@/lib/media/avatar-objects';
import {
  avatarSourceOf,
  avatarUrlOf,
  copiesAvatar,
  isProviderPictureUrl,
  NotOurAvatarError,
  ownAvatar,
} from '@/lib/media/avatar-url';
import {
  atOurSize,
  AvatarCopyError,
  copyProviderPicture,
  fetchProviderPicture,
  syncAvatarAtSignIn,
} from '@/lib/media/avatars';
import { AVATAR_SIZE, processAvatar } from '@/lib/media/image';
import { avatarKey, isObjectKey } from '@/lib/media/keys';
import { LocalMediaStorage } from '@/lib/media/local';
import type { MediaStorage } from '@/lib/media/storage';

/**
 * PROFILE PICTURES ARE OUR OWN COPIES (#458): what is fetched, what is kept,
 * what is shown, and when a sign-in replaces it.
 */

const USER = 'cm1userabcdefghijklmnopq';
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c';
const FACEBOOK = 'https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1&ext=2&hash=3';
const HASH = 'a'.repeat(64);

async function jpeg(width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: 'GPS secret', Copyright: 'Somebody' } })
    .toBuffer();
}

/** A fetch that answers from a table of URL → Response. */
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected fetch ${url}`);
    return answer();
  }) as typeof fetch;
  return { fn, calls };
}

const image =
  (body: Buffer, type = 'image/jpeg') =>
  () =>
    new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } });

function memoryStorage(): MediaStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: 'local',
    objects,
    async put(key, body) {
      if (objects.has(key)) throw new Error(`Object already exists: ${key}`);
      objects.set(key, body);
    },
    async deleteMany(keys) {
      for (const k of keys) objects.delete(k);
    },
    async list(prefix) {
      return {
        items: [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key, createdAt: new Date(0) })),
        nextPageToken: null,
      };
    },
  };
}

describe('what is stored and what is shown', () => {
  const key = avatarKey(USER, 'facebook', HASH);

  it('a copy is avatars/{userId}/{source}-{hash}.webp, a name the adapters accept', () => {
    expect(key).toBe(`avatars/${USER}/facebook-${'a'.repeat(32)}.webp`);
    expect(isObjectKey(key)).toBe(true);
    expect(isObjectKey(`avatars/${USER}/other-${'a'.repeat(32)}.webp`)).toBe(false);
    expect(isObjectKey(`avatars/${USER}/../facebook-${'a'.repeat(32)}.webp`)).toBe(false);
    expect(() => avatarKey('../x', 'google', HASH)).toThrow();
  });

  it('shows our copy from MEDIA_PUBLIC_BASE_URL, and nothing else, ever', () => {
    const base = 'https://storage.googleapis.com/playerz-media-hazel';
    expect(avatarUrlOf(key, base)).toBe(`${base}/${key}`);
    expect(avatarUrlOf(GOOGLE, base)).toBeNull();
    expect(avatarUrlOf(FACEBOOK, base)).toBeNull();
    expect(avatarUrlOf(null, base)).toBeNull();
    expect(avatarUrlOf(key, null)).toBeNull();
  });

  it('stores our copy or null, and refuses a provider URL', () => {
    expect(ownAvatar(key)).toBe(key);
    expect(ownAvatar(null)).toBeNull();
    expect(() => ownAvatar(GOOGLE)).toThrow(NotOurAvatarError);
    expect(() => ownAvatar('https://evil.example/x.png')).toThrow(NotOurAvatarError);
  });

  it('knows where a stored picture came from', () => {
    expect(avatarSourceOf(key)).toBe('facebook');
    expect(avatarSourceOf(avatarKey(USER, 'google', HASH))).toBe('google');
    expect(avatarSourceOf(GOOGLE)).toBe('google');
    expect(avatarSourceOf(FACEBOOK)).toBe('facebook');
    expect(avatarSourceOf('https://scontent.xx.fbcdn.net/v/p.jpg')).toBe('facebook');
    expect(avatarSourceOf('https://evilfbsbx.com/p.jpg')).toBeNull();
    expect(avatarSourceOf(null)).toBeNull();
  });

  it.each([
    ['google', null, true],
    ['facebook', null, true],
    ['facebook', avatarKey(USER, 'facebook', HASH), true],
    ['google', avatarKey(USER, 'facebook', HASH), false],
    ['facebook', avatarKey(USER, 'google', HASH), false],
    ['google', avatarKey(USER, 'google', HASH), false],
    ['google', GOOGLE, true],
    ['facebook', FACEBOOK, true],
    ['facebook', GOOGLE, false],
    ['google', FACEBOOK, false],
    ['google', 'https://example.com/me.png', false],
  ] as const)('a %s sign-in over %s copies: %s', (source, stored, expected) => {
    expect(copiesAvatar(source, stored)).toBe(expected);
  });

  it('asks the providers for the picture at our size', () => {
    expect(atOurSize(GOOGLE)).toBe(`https://lh3.googleusercontent.com/a/ACg8ocK=s${AVATAR_SIZE}-c`);
    expect(atOurSize(FACEBOOK)).toBe(FACEBOOK);
    expect(FACEBOOK_USERINFO_FIELDS).toContain(`picture.width(${AVATAR_SIZE})`);
  });
});

describe('fetching a provider’s picture', () => {
  it('reads an image from a provider host, following a redirect to another', async () => {
    const body = await jpeg();
    const cdn = 'https://scontent.xx.fbcdn.net/v/p.jpg';
    const { fn, calls } = fakeFetch({
      [FACEBOOK]: () => new Response(null, { status: 302, headers: { location: cdn } }),
      [cdn]: image(body),
    });
    await expect(fetchProviderPicture(FACEBOOK, { fetch: fn })).resolves.toEqual(body);
    expect(calls).toEqual([FACEBOOK, cdn]);
  });

  it.each([
    ['a host that is not a provider’s', 'https://evil.example/p.jpg', {}, 'HOST'],
    ['a provider-looking host', 'https://lh3.googleusercontent.com.evil.example/p', {}, 'HOST'],
    ['a scheme other than http(s)', 'file:///etc/passwd', {}, 'HOST'],
  ])('refuses %s', async (_what, url, _x, reason) => {
    await expect(fetchProviderPicture(url, { fetch: fakeFetch({}).fn })).rejects.toMatchObject({
      reason,
    });
  });

  it('refuses a redirect off the provider hosts, an error, a non-image and too many bytes', async () => {
    const big = Buffer.alloc(64);
    const cases: Array<[() => Response, string, { maxBytes?: number }]> = [
      [
        () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
        'HOST',
        {},
      ],
      [() => new Response('gone', { status: 404 }), 'STATUS', {}],
      [image(Buffer.from('<html>'), 'text/html'), 'TYPE', {}],
      [image(big), 'TOO_LARGE', { maxBytes: 16 }],
    ];
    for (const [answer, reason, opts] of cases) {
      const { fn } = fakeFetch({ [GOOGLE]: answer });
      await expect(fetchProviderPicture(GOOGLE, { fetch: fn, ...opts })).rejects.toMatchObject({
        reason,
      });
    }
  });

  it('gives up after its time, and a network failure is a NETWORK failure', async () => {
    const hang = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as typeof fetch;
    const err = await fetchProviderPicture(GOOGLE, { fetch: hang, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AvatarCopyError);
    expect((err as AvatarCopyError).reason).toBe('NETWORK');
  });
});

describe('the copy we keep', () => {
  it('is one square WebP of at most AVATAR_SIZE px, with no metadata of the original', async () => {
    const out = await processAvatar(await jpeg(800, 600));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([AVATAR_SIZE, AVATAR_SIZE]);
    expect(meta.exif).toBeUndefined();
    expect(out.toString('latin1')).not.toContain('GPS secret');
  });

  it('is never enlarged, and refuses what is not an image', async () => {
    const meta = await sharp(await processAvatar(await jpeg(50, 50))).metadata();
    expect([meta.width, meta.height]).toEqual([50, 50]);
    await expect(
      processAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).rejects.toMatchObject({
      reason: 'UNSUPPORTED_TYPE',
    });
  });

  it('is named by its bytes: the same picture twice is one object', async () => {
    const storage = memoryStorage();
    const { fn } = fakeFetch({ [FACEBOOK]: image(await jpeg()) });
    const input = { userId: USER, source: 'facebook' as const, url: FACEBOOK };
    const a = await copyProviderPicture(storage, input, { fetch: fn });
    const b = await copyProviderPicture(storage, input, { fetch: fn });
    expect(a).toBe(b);
    expect(a).toMatch(new RegExp(`^avatars/${USER}/facebook-[0-9a-f]{32}\\.webp$`));
    expect([...storage.objects.keys()]).toEqual([a]);
  });
});

describe('at sign-in', () => {
  async function signIn(over: {
    provider?: string;
    stored?: string | null;
    picture?: string | null;
    body?: () => Response;
    saves?: boolean;
    storage?: ReturnType<typeof memoryStorage>;
  }) {
    const storage = over.storage ?? memoryStorage();
    const picture = over.picture === undefined ? FACEBOOK : over.picture;
    const { fn } = fakeFetch(
      picture ? { [atOurSize(picture)]: over.body ?? image(await jpeg()) } : {},
    );
    const save = jest.fn(async () => over.saves ?? true);
    await syncAvatarAtSignIn(
      {
        provider: over.provider ?? 'facebook',
        userId: USER,
        stored: over.stored ?? null,
        picture,
        save,
      },
      storage,
      { fetch: fn },
    );
    return { storage, save };
  }

  it('a first sign-in keeps a copy and saves its key', async () => {
    const { storage, save } = await signIn({ provider: 'google', picture: GOOGLE });
    const [key] = [...storage.objects.keys()];
    expect(key).toMatch(/^avatars\/.+\/google-[0-9a-f]{32}\.webp$/);
    expect(save).toHaveBeenCalledWith(key);
  });

  it('a Facebook sign-in with a new picture replaces the copy and deletes the old object', async () => {
    const storage = memoryStorage();
    const old = avatarKey(USER, 'facebook', HASH);
    storage.objects.set(old, Buffer.from('old'));
    const { save } = await signIn({ stored: old, storage });
    const [now] = [...storage.objects.keys()];
    expect(now).not.toBe(old);
    expect(save).toHaveBeenCalledWith(now);
    expect(storage.objects.has(old)).toBe(false);
  });

  it('the same Facebook picture again writes nothing', async () => {
    const first = await signIn({});
    const [key] = [...first.storage.objects.keys()];
    const again = await signIn({ stored: key!, storage: first.storage });
    expect(again.save).not.toHaveBeenCalled();
    expect([...again.storage.objects.keys()]).toEqual([key]);
  });

  it('never replaces a picture from the other provider', async () => {
    const google = avatarKey(USER, 'google', HASH);
    const { storage, save } = await signIn({ stored: google });
    expect(save).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(0);
  });

  it('a Facebook silhouette clears a Facebook copy; a Google profile with none leaves it', async () => {
    const storage = memoryStorage();
    const old = avatarKey(USER, 'facebook', HASH);
    storage.objects.set(old, Buffer.from('old'));
    const { save } = await signIn({ stored: old, picture: null, storage });
    expect(save).toHaveBeenCalledWith(null);
    expect(storage.objects.size).toBe(0);

    const google = await signIn({ provider: 'google', stored: null, picture: null });
    expect(google.save).not.toHaveBeenCalled();
  });

  it('a failed copy keeps our earlier copy, and clears a provider URL from before #458', async () => {
    const broken = () => new Response('expired', { status: 403 });
    const ours = avatarKey(USER, 'facebook', HASH);
    const kept = await signIn({ stored: ours, body: broken });
    expect(kept.save).not.toHaveBeenCalled();

    const legacy = await signIn({ stored: FACEBOOK.replace('hash=3', 'hash=4'), body: broken });
    expect(legacy.save).toHaveBeenCalledWith(null);
  });

  it('when another sign-in saved first, deletes nothing', async () => {
    const storage = memoryStorage();
    const old = avatarKey(USER, 'facebook', HASH);
    storage.objects.set(old, Buffer.from('old'));
    await signIn({ stored: old, storage, saves: false });
    expect(storage.objects.has(old)).toBe(true);
  });

  it('never throws, and does nothing without media storage', async () => {
    const save = jest.fn(async () => true);
    await expect(
      syncAvatarAtSignIn(
        { provider: 'google', userId: USER, stored: null, picture: GOOGLE, save },
        null,
      ),
    ).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    const failing = jest.fn(async (): Promise<boolean> => {
      throw new Error('db down');
    });
    await expect(
      syncAvatarAtSignIn(
        { provider: 'google', userId: USER, stored: null, picture: GOOGLE, save: failing },
        memoryStorage(),
        { fetch: fakeFetch({ [atOurSize(GOOGLE)]: image(await jpeg()) }).fn },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('deleting copies', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pilot-avatars-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('account deletion deletes every copy of the account, and only its', async () => {
    const storage = new LocalMediaStorage(dir);
    const other = 'cm1otheruserabcdefghijklm';
    await storage.put(avatarKey(USER, 'google', HASH), Buffer.from('a'));
    await storage.put(avatarKey(USER, 'facebook', 'b'.repeat(64)), Buffer.from('b'));
    await storage.put(avatarKey(other, 'google', HASH), Buffer.from('c'));
    await expect(purgeAvatarObjects(storage, USER)).resolves.toBe(2);
    const left = await storage.list('avatars/');
    expect(left.items.map((i) => i.key)).toEqual([avatarKey(other, 'google', HASH)]);
  });

  it('the sweep deletes the old copies no live account names', async () => {
    const storage = memoryStorage();
    const named = avatarKey(USER, 'google', HASH);
    const replaced = avatarKey(USER, 'facebook', HASH);
    const deletedAccount = avatarKey('cm1deletedabcdefghijklmn', 'google', HASH);
    for (const k of [named, replaced, deletedAccount]) storage.objects.set(k, Buffer.from('x'));
    const findMany = jest.fn(async () => [
      { avatarUrl: named, deletedAt: null },
      { avatarUrl: null, deletedAt: new Date() },
    ]);
    const db = { user: { findMany } } as never;
    const result = await sweepOrphanAvatars(db, storage, { now: new Date(2 * 86_400_000) });
    expect(result).toEqual({ scanned: 3, deleted: 2, truncated: false });
    expect([...storage.objects.keys()]).toEqual([named]);
  });
});
