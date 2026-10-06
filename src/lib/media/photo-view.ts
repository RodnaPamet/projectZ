import { siteUrl } from '@/lib/seo/site-url';

import { renditionKey } from './keys';
import { mediaConfig } from './config';
import type { PhotoView } from './photo-shape';

export type { PhotoVariant, PhotoView } from './photo-shape';
export { srcSetOf } from './photo-shape';

/**
 * A stored venue photo as pages and the v1 API show it (#366): every
 * rendition's absolute URL, the default one, its box and its placeholder.
 *
 * URLs are built HERE, from the row's `objectKey` and `widths` and the
 * current `MEDIA_PUBLIC_BASE_URL`, never read from a stored URL, so moving
 * the bucket behind a CDN is a config change. A relative base (`/media`, the
 * local adapter) is made absolute on the site's canonical origin, because the
 * structured data, Open Graph and a native client all need absolute URLs.
 *
 * A row from before P47 (no `objectKey`) is shown as one image at its `url`.
 */

export interface PhotoRow {
  id: string;
  kind: 'COVER' | 'GALLERY';
  url: string;
  alt: string | null;
  position: number;
  objectKey: string | null;
  widths: number[];
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
}

/** The columns `toPhotoView` reads, for a Prisma `select`. */
export const PHOTO_SELECT = {
  id: true,
  kind: true,
  url: true,
  alt: true,
  position: true,
  objectKey: true,
  widths: true,
  width: true,
  height: true,
  blurDataUrl: true,
} as const;

export function mediaBaseUrl(): string | null {
  const base = mediaConfig().publicBaseUrl;
  if (!base) return null;
  return base.startsWith('/') ? new URL(base, siteUrl()).toString().replace(/\/+$/, '') : base;
}

export function toPhotoView(row: PhotoRow, base: string | null = mediaBaseUrl()): PhotoView {
  const widths = [...row.widths].sort((a, b) => a - b);
  if (!row.objectKey || widths.length === 0 || !base) {
    return {
      id: row.id,
      alt: row.alt ?? '',
      url: row.url,
      width: row.width,
      height: row.height,
      variants: [],
      blurDataUrl: row.blurDataUrl,
    };
  }
  const stem = row.objectKey;
  const variants = widths.map((w) => ({ width: w, url: `${base}/${renditionKey(stem, w)}` }));
  const preferred = [...variants].reverse().find((v) => v.width <= 1280) ?? variants[0]!;
  return {
    id: row.id,
    alt: row.alt ?? '',
    url: preferred.url,
    width: row.width,
    height: row.height,
    variants,
    blurDataUrl: row.blurDataUrl,
  };
}

/** Split a venue's photo rows into its cover and its gallery, in order. */
export function splitPhotos(rows: readonly PhotoRow[]): {
  cover: PhotoView | null;
  gallery: PhotoView[];
} {
  const base = mediaBaseUrl();
  const cover = rows.find((r) => r.kind === 'COVER');
  const gallery = rows
    .filter((r) => r.kind === 'GALLERY')
    .sort((a, b) => a.position - b.position)
    .map((r) => toPhotoView(r, base));
  return { cover: cover ? toPhotoView(cover, base) : null, gallery };
}
