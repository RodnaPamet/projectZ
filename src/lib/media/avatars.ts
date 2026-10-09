import { createHash } from 'node:crypto';

import { logger } from '@/lib/observability/logger';

import { copiesAvatar, isAvatarKey, isProviderPictureUrl, ownAvatar } from './avatar-url';
import { AVATAR_SIZE, ImageRejectedError, processAvatar } from './image';
import { avatarKey, IMMUTABLE_CACHE_CONTROL, type AvatarSource } from './keys';
import type { MediaStorage } from './storage';

/**
 * A COPY OF THE PROFILE PICTURE, MADE AT SIGN-IN (#458).
 *
 * Google and Facebook send a picture URL with the profile. Shown as it is, it
 * sends every viewer's IP address to Google or Meta, and Facebook's stops
 * working within weeks. So the server fetches it once, at sign-in, and keeps
 * its own copy in the media bucket (docs/media-storage.md):
 *
 *   fetch     only from Google's or Facebook's picture hosts, every redirect
 *             included; http(s), an `image/*` answer, at most
 *             `AVATAR_MAX_BYTES`, within `AVATAR_FETCH_TIMEOUT_MS` in all
 *   process   `processAvatar`: the upload checks, then one square WebP of at
 *             most `AVATAR_SIZE` px, re-encoded from pixels with no metadata
 *   store     `avatars/{userId}/{source}-{hash}.webp`, create-only and
 *             immutable; the key goes in `User.avatarUrl` (`ownAvatar`)
 *   show      `avatarUrlOf`, from `MEDIA_PUBLIC_BASE_URL`
 *
 * The name is the hash of the bytes written, so a Facebook sign-in that brings
 * the same picture again writes nothing, and a new picture is a new name: the
 * old object is deleted once the new key is saved.
 *
 * Nothing here fails a sign-in. A picture that cannot be copied leaves the
 * initials (`InitialsAvatar`), and the next sign-in tries again.
 */

/** The most a provider's picture may weigh. Theirs are tens of kilobytes. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** The whole fetch, redirects and body included: a sign-in waits for it. */
export const AVATAR_FETCH_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;

export type AvatarCopyFailure = 'HOST' | 'STATUS' | 'TYPE' | 'TOO_LARGE' | 'REDIRECTS' | 'NETWORK';

export class AvatarCopyError extends Error {
  constructor(readonly reason: AvatarCopyFailure) {
    super(`Profile picture not copied: ${reason}`);
    this.name = 'AvatarCopyError';
  }
}

/** Why a copy failed, as a code: a log line never carries the URL, which is signed. */
export function copyFailureOf(error: unknown): string {
  if (error instanceof AvatarCopyError || error instanceof ImageRejectedError) return error.reason;
  return 'STORAGE';
}

/** The picture at our size: Google's URL carries it (`=s96-c`); Facebook's fields ask for it. */
export function atOurSize(url: string): string {
  const u = new URL(url);
  if (u.hostname === 'googleusercontent.com' || u.hostname.endsWith('.googleusercontent.com')) {
    u.pathname = u.pathname.replace(/=s\d+(-c)?$/, `=s${AVATAR_SIZE}-c`);
  }
  return u.toString();
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new AvatarCopyError('TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The bytes of a provider's picture. Throws `AvatarCopyError` for a host that
 * is not Google's or Facebook's (at any hop), an answer that is not 2xx or not
 * an image, one too large, or too many redirects.
 */
export async function fetchProviderPicture(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? AVATAR_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? AVATAR_FETCH_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isProviderPictureUrl(current)) throw new AvatarCopyError('HOST');
    let res: Response;
    try {
      res = await doFetch(current, { redirect: 'manual', signal, headers: { accept: 'image/*' } });
    } catch {
      throw new AvatarCopyError('NETWORK');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new AvatarCopyError('STATUS');
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new AvatarCopyError('STATUS');
    if (!/^image\//i.test(res.headers.get('content-type') ?? '')) {
      throw new AvatarCopyError('TYPE');
    }
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
      throw new AvatarCopyError('TOO_LARGE');
    }
    try {
      return await readCapped(res.body, maxBytes);
    } catch (e) {
      if (e instanceof AvatarCopyError) throw e;
      throw new AvatarCopyError('NETWORK');
    }
  }
  throw new AvatarCopyError('REDIRECTS');
}

/** A create-only write that found its name taken: the same bytes, by the name's hash. */
function alreadyStored(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === 412 || (typeof e?.message === 'string' && /already exists/i.test(e.message));
}

/** Copy a provider's picture into `storage`, and return the copy's key. Throws on any failure. */
export async function copyProviderPicture(
  storage: MediaStorage,
  input: { userId: string; source: AvatarSource; url: string },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const bytes = await fetchProviderPicture(atOurSize(input.url), opts);
  const webp = await processAvatar(bytes);
  const key = avatarKey(
    input.userId,
    input.source,
    createHash('sha256').update(webp).digest('hex'),
  );
  try {
    await storage.put(key, webp, {
      contentType: 'image/webp',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });
  } catch (error) {
    if (!alreadyStored(error)) throw error;
  }
  return key;
}

/** Delete copies; a failure is logged, and the daily sweep finds what is left. */
async function deleteQuietly(storage: MediaStorage, keys: string[]): Promise<void> {
  try {
    await storage.deleteMany(keys);
  } catch (error) {
    logger.warn('profile picture: an old copy was not deleted', {
      component: 'media',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * At sign-in: copy the provider's picture when `copiesAvatar` says so, save
 * the key, and delete the copy it replaced. Never throws.
 *
 * A Facebook sign-in that brings no picture (a silhouette) clears a Facebook
 * one, as before #458; a Google profile without one leaves what is there.
 * When the copy fails, our own earlier copy stays, and a provider's URL from
 * before #458 is cleared, so nothing stored points at Google or Meta.
 */
export async function syncAvatarAtSignIn(
  input: {
    provider: string;
    userId: string;
    stored: string | null;
    picture: string | null;
    /**
     * Writes `User.avatarUrl` if it still holds `stored`, and says whether it
     * did; given by the caller, which holds the binding.
     */
    save: (avatarUrl: string | null) => Promise<boolean>;
  },
  storage: MediaStorage | null,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const source =
    input.provider === 'google' || input.provider === 'facebook' ? input.provider : null;
  if (!source || !storage || !copiesAvatar(source, input.stored)) return;
  if (!input.picture && source === 'google') return;

  let next: string | null = null;
  if (input.picture) {
    try {
      next = await copyProviderPicture(
        storage,
        { userId: input.userId, source, url: input.picture },
        opts,
      );
    } catch (error) {
      logger.warn('sign-in: the profile picture was not copied', {
        component: 'auth',
        provider: source,
        reason: copyFailureOf(error),
      });
      if (isAvatarKey(input.stored)) return;
    }
  }
  if (next === input.stored) return;

  // Not saved (a failure, or another sign-in got there first): nothing is
  // deleted here. Two sign-ins copying the same picture write the same name,
  // so `next` may be the one the other saved; the sweep deletes a copy that
  // nobody names.
  let saved: boolean;
  try {
    saved = await input.save(ownAvatar(next));
  } catch (error) {
    logger.warn('sign-in: the profile picture was not saved', {
      component: 'auth',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return;
  }
  if (saved && isAvatarKey(input.stored)) await deleteQuietly(storage, [input.stored]);
}
