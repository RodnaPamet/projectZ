import sharp, { type Metadata } from 'sharp';

import { MAX_INPUT_PIXELS, MAX_UPLOAD_BYTES, MIN_DIMENSION, RENDITION_WIDTHS } from './limits';

/**
 * From an uploaded file to the WebP renditions a page shows (#366).
 *
 * ═══ WHAT IS ACCEPTED, AND HOW THAT IS DECIDED ═══
 *
 * JPEG, PNG, WebP and HEIF/HEIC, decided by the file's MAGIC BYTES — never by
 * its name, never by the browser's `type`, both of which the sender writes.
 * Everything else is refused before the decoder sees it. That matters most for
 * SVG: the prebuilt libvips inside sharp includes librsvg and WOULD render an
 * SVG, so "let sharp work out what it is" would accept a script-bearing XML
 * document. After decoding, sharp's own idea of the format must agree with the
 * sniffed one, or the file is refused (a JPEG header glued to something else).
 *
 * HEIC caveat, measured: sharp's prebuilt libvips decodes AVIF but not HEVC
 * (patents), so most iPhone HEIC files fail to decode and are refused with
 * UNREADABLE. iOS converts a picked HEIC photo to JPEG when the file input
 * does not list HEIC in `accept`, which is how the admin's input is written,
 * so a phone upload arrives as JPEG.
 *
 * ═══ NOTHING OF THE ORIGINAL SURVIVES ═══
 *
 * Every rendition is re-encoded from decoded pixels, so a polyglot (a valid
 * JPEG that is also an HTML page or a ZIP) comes out as pixels only. sharp
 * writes no metadata unless asked, so EXIF, GPS, XMP and the camera's ICC
 * profile are all dropped; `.rotate()` applies the EXIF orientation first, so
 * a portrait photo stays upright without it.
 *
 * ═══ DECOMPRESSION BOMBS ═══
 *
 * A 100 KB PNG can declare 50,000 × 50,000 pixels: 10 GB once decoded. The
 * header is read first (`metadata()` decodes nothing) and anything over
 * `MAX_INPUT_PIXELS` is refused there; `limitInputPixels` is set on every
 * decoder as well, so libvips enforces the same ceiling itself. Animated
 * input is read as its first frame only. Uploads are processed one at a time
 * (`serially`), so a burst cannot multiply the memory a decode takes on a VM
 * shared with another product.
 */

export {
  DEFAULT_WIDTH,
  MAX_INPUT_PIXELS,
  MAX_UPLOAD_BYTES,
  MIN_DIMENSION,
  RENDITION_WIDTHS,
} from './limits';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'heif';

export type ImageRejection =
  'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'TOO_MANY_PIXELS' | 'TOO_SMALL' | 'UNREADABLE';

export class ImageRejectedError extends Error {
  constructor(readonly reason: ImageRejection) {
    super(`Image rejected: ${reason}`);
    this.name = 'ImageRejectedError';
  }
}

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'avif',
  'avis',
]);

/** The format the first bytes declare, or null for anything not accepted. */
export function sniffImageFormat(buf: Uint8Array): ImageFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(8, 12))) return 'heif';
  return null;
}

export interface Rendition {
  width: number;
  height: number;
  body: Buffer;
}

export interface ProcessedImage {
  format: ImageFormat;
  /** Ascending by width; the last is the largest. */
  renditions: Rendition[];
  /** `data:image/webp;base64,…`, about 16 px wide. */
  blurDataUrl: string;
}

const decoder = (input: Buffer) =>
  sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
    animated: false,
    sequentialRead: true,
  });

/** Which widths to produce for an image `width` px wide (after orientation). */
export function renditionWidths(width: number): number[] {
  const out: number[] = RENDITION_WIDTHS.filter((w) => w < width);
  if (width <= RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1]!) out.push(width);
  else if (!out.includes(1920)) out.push(1920);
  return [...new Set(out)].sort((a, b) => a - b);
}

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier call has finished: one decode at a time. */
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function processUpload(input: Buffer): Promise<ProcessedImage> {
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageRejectedError('TOO_LARGE');
  const format = sniffImageFormat(input);
  if (!format) throw new ImageRejectedError('UNSUPPORTED_TYPE');
  return serially(() => decodeAndResize(input, format));
}

/** The header's size, upright, once the format and the pixel count are checked. */
async function checkedSize(
  input: Buffer,
  format: ImageFormat,
): Promise<{ width: number; height: number }> {
  let meta: Metadata;
  try {
    meta = await decoder(input).metadata();
  } catch (e) {
    // libvips checks `limitInputPixels` against the header here already.
    throw new ImageRejectedError(
      e instanceof Error && /pixel limit/i.test(e.message) ? 'TOO_MANY_PIXELS' : 'UNREADABLE',
    );
  }
  if (meta.format !== format) throw new ImageRejectedError('UNSUPPORTED_TYPE');
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;
  if (w0 * h0 > MAX_INPUT_PIXELS) throw new ImageRejectedError('TOO_MANY_PIXELS');
  // EXIF orientations 5–8 are a quarter turn: width and height swap.
  const turned = (meta.orientation ?? 1) >= 5;
  return { width: turned ? h0 : w0, height: turned ? w0 : h0 };
}

/** A profile picture's copy (#458): square, at most this many pixels a side. */
export const AVATAR_SIZE = 256;

/**
 * A profile picture as we keep it (#458): one square WebP, at most
 * `AVATAR_SIZE` a side, cropped to the centre and never enlarged, re-encoded
 * from pixels, so no metadata of the original survives. The same format and
 * pixel checks as an upload, and one decode at a time with them; no minimum
 * size, since a provider's picture can be 50 px.
 */
export async function processAvatar(input: Buffer): Promise<Buffer> {
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageRejectedError('TOO_LARGE');
  const format = sniffImageFormat(input);
  if (!format) throw new ImageRejectedError('UNSUPPORTED_TYPE');
  return serially(async () => {
    await checkedSize(input, format);
    try {
      return await decoder(input)
        .rotate()
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch {
      throw new ImageRejectedError('UNREADABLE');
    }
  });
}

async function decodeAndResize(input: Buffer, format: ImageFormat): Promise<ProcessedImage> {
  const { width, height } = await checkedSize(input, format);
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) throw new ImageRejectedError('TOO_SMALL');

  try {
    const renditions: Rendition[] = [];
    for (const w of renditionWidths(width)) {
      const { data, info } = await decoder(input)
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      renditions.push({ width: info.width, height: info.height, body: data });
    }
    const blur = await decoder(input)
      .rotate()
      .resize({ width: 16 })
      .webp({ quality: 40 })
      .toBuffer();
    return {
      format,
      renditions,
      blurDataUrl: `data:image/webp;base64,${blur.toString('base64')}`,
    };
  } catch (e) {
    if (e instanceof Error && /pixel limit/i.test(e.message)) {
      throw new ImageRejectedError('TOO_MANY_PIXELS');
    }
    throw new ImageRejectedError('UNREADABLE');
  }
}
