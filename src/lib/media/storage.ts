import { GcsMediaStorage } from './gcs';
import { mediaConfig } from './config';
import { LocalMediaStorage } from './local';

/**
 * Where venue photos live (#366): one interface, two adapters, chosen by env.
 *
 *   MEDIA_STORAGE=gcs     Google Cloud Storage, the bucket beside the VM
 *                         (`GCS_BUCKET`). Production and staging.
 *   MEDIA_STORAGE=local   a directory (`MEDIA_LOCAL_DIR`, default `.media`),
 *                         served by `src/app/media/[...key]/route.ts`. Dev,
 *                         tests, CI and the E2E build.
 *   unset                 uploads are OFF. `getMediaStorage()` is null and the
 *                         admin says "Качването на снимки не е настроено";
 *                         nothing throws, and photos already stored still
 *                         render from `MEDIA_PUBLIC_BASE_URL`.
 *
 * ═══ WHY LOCAL SERVES THROUGH A ROUTE, NOT public/ ═══
 *
 * `next start` serves the `public/` files that existed when it booted: a file
 * written there afterwards is a 404 until a restart (and a build copies the
 * folder into the image, uploads and all). The E2E suite uploads against a
 * production build and then reads the photo back, so local storage needs a
 * reader that sees new files, and a route is that. It answers 404 for every
 * request unless `MEDIA_STORAGE=local`, so on the VM it serves nothing.
 *
 * Read from `process.env` on each call, not from `@/env`'s import-time copy,
 * so a test can switch adapters; `src/env.ts` validates the values at boot.
 */

export interface StoredObject {
  key: string;
  createdAt: Date;
}

export interface MediaStorage {
  readonly kind: 'gcs' | 'local';
  /** Write one object. Refuses to overwrite: names are immutable. */
  put(
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl: string },
  ): Promise<void>;
  /** Delete objects; a key that is already gone is not an error. */
  deleteMany(keys: readonly string[]): Promise<void>;
  /** One page of the objects under `prefix`, oldest information first is not promised. */
  list(
    prefix: string,
    opts?: { pageToken?: string; maxResults?: number },
  ): Promise<{ items: StoredObject[]; nextPageToken: string | null }>;
}

let cached: { signature: string; storage: MediaStorage } | null = null;

/**
 * The configured adapter, or null when uploads are not set up. `gcs` without
 * a bucket counts as not set up, so a half-written .env turns uploads off
 * rather than failing on the first photo.
 */
export function getMediaStorage(env: NodeJS.ProcessEnv = process.env): MediaStorage | null {
  const cfg = mediaConfig(env);
  if (!cfg.storage || !cfg.publicBaseUrl) return null;
  if (cfg.storage === 'gcs' && !cfg.bucket) return null;

  const signature = JSON.stringify([cfg.storage, cfg.bucket, cfg.credentialsBase64, cfg.localDir]);
  if (cached?.signature === signature) return cached.storage;

  const storage =
    cfg.storage === 'gcs'
      ? new GcsMediaStorage(cfg.bucket!, cfg.credentialsBase64)
      : new LocalMediaStorage(cfg.localDir);
  cached = { signature, storage };
  return storage;
}

/** Whether uploads are configured: what the admin screen asks. */
export function mediaUploadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getMediaStorage(env) !== null;
}
