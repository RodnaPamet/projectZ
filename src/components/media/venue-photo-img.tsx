import type { CSSProperties } from 'react';

import { cn } from '@/lib/cn';
import { srcSetOf, type PhotoView } from '@/lib/media/photo-shape';

/**
 * One venue photo (#366) as a plain responsive `<img>`: every rendition in
 * `srcset`, the caller's `sizes`, the intrinsic box (no layout shift) and the
 * blurred placeholder painted behind it until the image arrives.
 *
 * ═══ WHY NOT next/image ═══
 *
 * The renditions are already WebP at 640/1280/1920 in a bucket with year-long
 * cache headers. `next/image` would either send every request through the
 * VM's `/_next/image` optimiser (a second resize, on the CPU agrent shares)
 * or, `unoptimized`, drop the srcset; and it is a client component, so it
 * would add JS to pages that ship none for this. An `<img>` the server renders
 * costs nothing in the bundle and the browser picks the width.
 *
 * No directive: it renders on the server, and inside the admin's client board.
 */

const BLUR = /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/;

export function VenuePhotoImg({
  photo,
  sizes,
  className,
  priority = false,
}: {
  photo: PhotoView;
  /** The `sizes` attribute: how wide the image is drawn at each viewport. */
  sizes: string;
  className?: string;
  /** The page's main image (a cover): load at once, not lazily. */
  priority?: boolean;
}) {
  const style: CSSProperties | undefined =
    photo.blurDataUrl && BLUR.test(photo.blurDataUrl)
      ? {
          backgroundImage: `url("${photo.blurDataUrl}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : undefined;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- pre-sized WebP renditions with their own srcset; see the comment above
    <img
      src={photo.url}
      srcSet={srcSetOf(photo)}
      sizes={sizes}
      alt={photo.alt}
      width={photo.width ?? undefined}
      height={photo.height ?? undefined}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      className={cn('object-cover', className)}
      style={style}
    />
  );
}
