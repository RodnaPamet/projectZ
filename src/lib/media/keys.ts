import { randomUUID } from 'node:crypto';

/**
 * Object names for venue photos (#366) and profile pictures (#458), and the
 * only code that builds them.
 *
 *   venues/{venueId}/{uuid}-{width}.webp           one rendition of a venue photo
 *   avatars/{userId}/{source}-{sha256/128}.webp    a profile picture's copy
 *
 * ═══ NOTHING A PERSON TYPED REACHES A NAME ═══
 *
 * The venue id comes from a row the tenant-bound read found, the uuid from
 * `randomUUID`, the width from the resizer. No file name, no alt text, no
 * extension from the upload. A picture's name is the account's id, the
 * provider it came from and a hash of the bytes we wrote. So an object name
 * cannot carry `..`, a slash or a query string, and every name is checked
 * against `OBJECT_KEY` or `AVATAR_KEY` again before it reaches a storage
 * adapter or the local `/media` route: a key that does not match is refused,
 * never "cleaned".
 *
 * ═══ IMMUTABLE ═══
 *
 * A new upload is a new uuid, so a name is never written twice. The bytes
 * behind a URL never change, which is what lets the objects carry a one-year
 * `immutable` Cache-Control: a replaced cover is a new URL, not a stale cache.
 * A picture's name is its content's hash, so the same picture copied again is
 * the same name, and a new one is a new name.
 */

/** A cuid (Prisma's default id): lower-case letters and digits. */
const ID = /^[a-z0-9]{8,40}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/** The stem every rendition of one upload shares. */
export const OBJECT_STEM = new RegExp(`^venues/[a-z0-9]{8,40}/${UUID}$`);
/** One rendition's object name. */
export const OBJECT_KEY = new RegExp(`^venues/[a-z0-9]{8,40}/${UUID}-[1-9][0-9]{1,3}\\.webp$`);

/** Where a profile picture was copied from. */
export type AvatarSource = 'google' | 'facebook';
/** A profile picture's copy (#458): the account, the provider, the content's hash. */
export const AVATAR_KEY = /^avatars\/[a-z0-9]{8,40}\/(google|facebook)-[0-9a-f]{32}\.webp$/;

/** The Cache-Control every object is written with. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export class InvalidObjectKeyError extends Error {
  constructor() {
    super('Refusing an object name that is not a venue-photo rendition or a profile picture.');
    this.name = 'InvalidObjectKeyError';
  }
}

/** A fresh stem for one upload to `venueId`. */
export function newObjectStem(venueId: string): string {
  if (!ID.test(venueId)) throw new InvalidObjectKeyError();
  return `venues/${venueId}/${randomUUID()}`;
}

/** The prefix under which every object of one venue lives. */
export function venuePrefix(venueId: string): string {
  if (!ID.test(venueId)) throw new InvalidObjectKeyError();
  return `venues/${venueId}/`;
}

export function renditionKey(stem: string, width: number): string {
  const key = `${stem}-${width}.webp`;
  if (!OBJECT_KEY.test(key)) throw new InvalidObjectKeyError();
  return key;
}

/** A name the app writes: a venue photo's rendition or a profile picture. */
export function assertObjectKey(key: string): string {
  if (!isObjectKey(key)) throw new InvalidObjectKeyError();
  return key;
}

export function isObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key) || AVATAR_KEY.test(key);
}

/** The prefix under which every picture of one account lives. */
export function avatarPrefix(userId: string): string {
  if (!ID.test(userId)) throw new InvalidObjectKeyError();
  return `avatars/${userId}/`;
}

/** A picture's name: the account, the provider, the first 128 bits of the bytes' SHA-256. */
export function avatarKey(userId: string, source: AvatarSource, sha256Hex: string): string {
  const key = `${avatarPrefix(userId)}${source}-${sha256Hex.slice(0, 32)}.webp`;
  if (!AVATAR_KEY.test(key)) throw new InvalidObjectKeyError();
  return key;
}

/** The stem of a rendition key, or null for anything else. */
export function stemOf(key: string): string | null {
  if (!OBJECT_KEY.test(key)) return null;
  return key.replace(/-[0-9]+\.webp$/, '');
}

/** Every rendition key of one upload. */
export function renditionKeys(stem: string, widths: readonly number[]): string[] {
  if (!OBJECT_STEM.test(stem)) throw new InvalidObjectKeyError();
  return widths.map((w) => renditionKey(stem, w));
}
