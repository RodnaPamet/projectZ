/**
 * @jest-environment node
 */
import { renditionWidths, sniffImageFormat } from '@/lib/media/image';
import {
  assertObjectKey,
  InvalidObjectKeyError,
  isObjectKey,
  newObjectStem,
  renditionKeys,
  stemOf,
} from '@/lib/media/keys';
import { mediaConfig } from '@/lib/media/config';
import { toPhotoView } from '@/lib/media/photo-view';

/**
 * The pure parts of venue photos (#366): object names, format sniffing, the
 * widths an upload is cut to, the settings and the URL building.
 */

const VENUE = 'cm1abcdefghijklmnopqrstu';

describe('object names', () => {
  it('a stem is venues/{venueId}/{uuid}, and its renditions match the pattern', () => {
    const stem = newObjectStem(VENUE);
    expect(stem).toMatch(new RegExp(`^venues/${VENUE}/[0-9a-f-]{36}$`));
    const keys = renditionKeys(stem, [640, 1280]);
    expect(keys).toEqual([`${stem}-640.webp`, `${stem}-1280.webp`]);
    expect(keys.every(isObjectKey)).toBe(true);
    expect(stemOf(keys[0]!)).toBe(stem);
  });

  it.each([
    '../etc/passwd',
    `venues/${VENUE}/../../.env`,
    `venues/${VENUE}/a.webp`,
    `venues/${VENUE}/00000000-0000-4000-8000-000000000000-640.webp?x=1`,
    `venues/${VENUE}/00000000-0000-4000-8000-000000000000-640.svg`,
    `venues/${VENUE.toUpperCase()}/00000000-0000-4000-8000-000000000000-640.webp`,
    `other/${VENUE}/00000000-0000-4000-8000-000000000000-640.webp`,
  ])('refuses %s', (key) => {
    expect(isObjectKey(key)).toBe(false);
    expect(() => assertObjectKey(key)).toThrow(InvalidObjectKeyError);
    expect(stemOf(key)).toBeNull();
  });

  it('refuses a venue id that is not a cuid', () => {
    expect(() => newObjectStem('../x')).toThrow(InvalidObjectKeyError);
    expect(() => newObjectStem('a/b')).toThrow(InvalidObjectKeyError);
  });
});

describe('sniffing', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  const ascii = (s: string) => new Uint8Array([...Buffer.from(s), ...new Array(16).fill(0)]);

  it.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['webp', ascii('RIFF\0\0\0\0WEBP')],
    ['heif', ascii('\0\0\0\x18ftypheic')],
    ['heif', ascii('\0\0\0\x18ftypavif')],
  ])('reads %s from the bytes', (format, buf) => {
    expect(sniffImageFormat(buf)).toBe(format);
  });

  it.each([
    ['svg', ascii('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['xml-declared svg', ascii('<?xml version="1.0"?><svg>')],
    ['html', ascii('<!doctype html><html>')],
    ['gif', ascii('GIF89a')],
    ['mp4', ascii('\0\0\0\x18ftypisom')],
    ['empty', new Uint8Array()],
  ])('refuses %s', (_l, buf) => {
    expect(sniffImageFormat(buf)).toBeNull();
  });
});

describe('rendition widths', () => {
  it.each([
    [300, [300]],
    [640, [640]],
    [800, [640, 800]],
    [1280, [640, 1280]],
    [1500, [640, 1280, 1500]],
    [1920, [640, 1280, 1920]],
    [4000, [640, 1280, 1920]],
  ])('%i px wide → %j', (w, expected) => {
    expect(renditionWidths(w)).toEqual(expected);
  });
});

describe('settings and URLs', () => {
  it('unset is off; gcs defaults its public base to the bucket; local to /media', () => {
    expect(mediaConfig({} as unknown as NodeJS.ProcessEnv).storage).toBeNull();
    expect(
      mediaConfig({ MEDIA_STORAGE: 'gcs', GCS_BUCKET: 'b-1' } as unknown as NodeJS.ProcessEnv)
        .publicBaseUrl,
    ).toBe('https://storage.googleapis.com/b-1');
    expect(
      mediaConfig({ MEDIA_STORAGE: 'local' } as unknown as NodeJS.ProcessEnv).publicBaseUrl,
    ).toBe('/media');
    expect(
      mediaConfig({
        MEDIA_STORAGE: 'gcs',
        GCS_BUCKET: 'b',
        MEDIA_PUBLIC_BASE_URL: 'https://media.playerz.bg/',
      } as unknown as NodeJS.ProcessEnv).publicBaseUrl,
    ).toBe('https://media.playerz.bg');
  });

  it('builds every rendition URL from the stem, and picks 1280 as the default', () => {
    const stem = `venues/${VENUE}/00000000-0000-4000-8000-000000000000`;
    const view = toPhotoView(
      {
        id: 'p1',
        kind: 'GALLERY',
        url: 'https://old.invalid/x',
        alt: 'Корт',
        position: 0,
        objectKey: stem,
        widths: [1920, 640, 1280],
        width: 1920,
        height: 1080,
        blurDataUrl: null,
      },
      'https://cdn.example',
    );
    expect(view.variants.map((v) => v.width)).toEqual([640, 1280, 1920]);
    expect(view.url).toBe(`https://cdn.example/${stem}-1280.webp`);
  });

  it('a row from before the uploads is one image at its stored url', () => {
    const view = toPhotoView(
      {
        id: 'p0',
        kind: 'COVER',
        url: 'https://old.invalid/cover.jpg',
        alt: null,
        position: 0,
        objectKey: null,
        widths: [],
        width: null,
        height: null,
        blurDataUrl: null,
      },
      'https://cdn.example',
    );
    expect(view).toMatchObject({ url: 'https://old.invalid/cover.jpg', alt: '', variants: [] });
  });
});
