import { randomUUID } from 'node:crypto';

/**
 * Object names for venue photos (#366), and the only code that builds them.
 *
 *   venues/{venueId}/{uuid}-{width}.webp     one rendition
 *
 * ═══ NOTHING A PERSON TYPED REACHES A NAME ═══
 *
 * The venue id comes from a row the tenant-bound read found, the uuid from
 * `randomUUID`, the width from the resizer. No file name, no alt text, no
 * extension from the upload. So an object name cannot carry `..`, a slash or
 * a query string, and every name is checked against `OBJECT_KEY` again before
 * it reaches a storage adapter or the local `/media` route: a key that does
 * not match is refused, never "cleaned".
 *
 * ═══ IMMUTABLE ═══
 *
 * A new upload is a new uuid, so a name is never written twice. The bytes
 * behind a URL never change, which is what lets the objects carry a one-year
 * `immutable` Cache-Control: a replaced cover is a new URL, not a stale cache.
 */

/** A cuid (Prisma's default id): lower-case letters and digits. */
const ID = /^[a-z0-9]{8,40}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/** The stem every rendition of one upload shares. */
export const OBJECT_STEM = new RegExp(`^venues/[a-z0-9]{8,40}/${UUID}$`);
/** One rendition's object name. */
export const OBJECT_KEY = new RegExp(`^venues/[a-z0-9]{8,40}/${UUID}-[1-9][0-9]{1,3}\\.webp$`);

/** The Cache-Control every object is written with. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export class InvalidObjectKeyError extends Error {
  constructor() {
    super('Refusing an object name that is not a venue-photo rendition.');
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
  return assertObjectKey(key);
}

export function assertObjectKey(key: string): string {
  if (!OBJECT_KEY.test(key)) throw new InvalidObjectKeyError();
  return key;
}

export function isObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key);
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
