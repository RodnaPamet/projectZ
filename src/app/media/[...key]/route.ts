import { type NextRequest, NextResponse } from 'next/server';

import { IMMUTABLE_CACHE_CONTROL, isObjectKey } from '@/lib/media/keys';
import { LocalMediaStorage } from '@/lib/media/local';
import { getMediaStorage } from '@/lib/media/storage';

/**
 * The local media adapter's reader (#366): `/media/venues/{venueId}/{uuid}-{w}.webp`.
 *
 * Answers ONLY when `MEDIA_STORAGE=local` (dev, tests, CI, the E2E build);
 * everywhere else, the VM included, it is a 404 and the photos come from the
 * bucket. storage.ts says why local files are served by a route and not from
 * `public/`.
 *
 * Public by design, like the bucket: these are a venue's marketing photos.
 * The key must match the rendition pattern exactly (`isObjectKey`), and the
 * adapter re-checks that the resolved path stays under its root, so a `..`
 * or an encoded slash reads nothing. `nosniff` and a fixed `image/webp` type:
 * nothing served here is ever interpreted as anything but an image.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  const storage = getMediaStorage();
  if (!(storage instanceof LocalMediaStorage)) return notFound();

  const { key: parts } = await params;
  const key = parts.join('/');
  if (!isObjectKey(key)) return notFound();

  const body = await storage.read(key);
  if (!body) return notFound();

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': IMMUTABLE_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}

function notFound() {
  return new NextResponse(null, { status: 404 });
}
