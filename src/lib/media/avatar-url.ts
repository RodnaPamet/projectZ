import { FACEBOOK_PICTURE_DOMAINS, isFacebookPictureUrl } from '@/lib/auth/facebook';

import { AVATAR_KEY, type AvatarSource } from './keys';
import { mediaBaseUrl } from './photo-view';

/**
 * PROFILE PICTURES ARE OURS (#458): what is stored, and what is shown.
 *
 * A Google or Facebook picture used to be stored and shown as the provider's
 * own URL. Facebook's expire within weeks, and every browser that showed one
 * sent its viewer's IP address to Google or Meta. Now sign-in copies the
 * picture into our media storage (`./avatars.ts`), and `User.avatarUrl` holds
 * that copy's object KEY (`avatars/{userId}/{source}-{hash}.webp`), as
 * `venue_photo.objectKey` does for a venue photo.
 *
 * Every read that hands a picture to a page, the API or the data export goes
 * through `avatarUrlOf`, which builds the URL from `MEDIA_PUBLIC_BASE_URL` and
 * returns null for anything that is not our key: a provider's URL stored
 * before #458 (until `scripts/backfill-avatars.ts` copies it) shows the
 * initials instead of reaching Google or Meta. Every write goes through
 * `ownAvatar`, which refuses anything but our key or null.
 * `tests/guardrails/profile-pictures-are-ours.test.ts` pins both.
 *
 * No imports beyond the key pattern, the media base URL and Facebook's hosts:
 * the read paths load this without sharp or a storage adapter.
 */

/** The hosts Google and Facebook serve profile pictures from. */
export const PROVIDER_PICTURE_HOSTS = [
  'googleusercontent.com',
  ...FACEBOOK_PICTURE_DOMAINS,
] as const;

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const onHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Is this an http(s) URL on a host Google or Facebook serves pictures from? */
export function isProviderPictureUrl(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && PROVIDER_PICTURE_HOSTS.some((d) => onHost(host, d));
}

/** Is this our copy's key? */
export function isAvatarKey(stored: string | null | undefined): stored is string {
  return typeof stored === 'string' && AVATAR_KEY.test(stored);
}

/**
 * Where a stored picture came from: our copy's provider, or the provider of a
 * URL stored before #458. Null for nothing, or anything else.
 */
export function avatarSourceOf(stored: string | null | undefined): AvatarSource | null {
  if (isAvatarKey(stored)) return AVATAR_KEY.exec(stored)![1] as AvatarSource;
  const host = stored ? hostOf(stored) : null;
  if (!host) return null;
  if (onHost(host, 'googleusercontent.com')) return 'google';
  if (isFacebookPictureUrl(stored)) return 'facebook';
  return null;
}

/**
 * Should a sign-in with `source` copy the picture it brought over `stored`?
 *
 *   nothing stored                    yes: the first sign-in, or a picture
 *                                     that went (a silhouette, a failed copy)
 *   our copy of a Facebook picture    yes, at a Facebook sign-in: the picture
 *                                     may have changed, and the same one is
 *                                     the same name, so nothing is rewritten
 *   our copy of a Google picture      no: Google's is stable
 *   a provider's URL from before #458 yes, when it is this provider's: the
 *                                     sign-in brought a fresh one to copy
 *
 * Never over a picture from the other provider: the account's first provider
 * chose it (#361).
 */
export function copiesAvatar(source: AvatarSource, stored: string | null): boolean {
  if (stored === null) return true;
  if (isAvatarKey(stored)) return source === 'facebook' && avatarSourceOf(stored) === 'facebook';
  return avatarSourceOf(stored) === source;
}

/**
 * The picture a page, the API or the export shows: our copy under
 * `MEDIA_PUBLIC_BASE_URL`, or null, and the initials show. Never a provider's
 * URL, and never anything when media is not configured.
 */
export function avatarUrlOf(
  stored: string | null | undefined,
  base: string | null = mediaBaseUrl(),
): string | null {
  return isAvatarKey(stored) && base ? `${base}/${stored}` : null;
}

export class NotOurAvatarError extends Error {
  constructor() {
    super('Refusing to store a profile picture that is not our own copy.');
    this.name = 'NotOurAvatarError';
  }
}

/** The value a write stores in `User.avatarUrl`: our copy's key, or null. Throws on anything else. */
export function ownAvatar(value: string | null): string | null {
  if (value !== null && !isAvatarKey(value)) throw new NotOurAvatarError();
  return value;
}
