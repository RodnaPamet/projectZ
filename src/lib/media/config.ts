/**
 * The media settings (#366), read from `process.env` on each call so a test
 * can switch them. No imports: a page can ask where photos are served from
 * without loading a storage adapter. See storage.ts for what each one means.
 */
export interface MediaConfig {
  storage: 'gcs' | 'local' | null;
  bucket: string | null;
  credentialsBase64: string | null;
  localDir: string;
  publicBaseUrl: string | null;
}

export function mediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const storage =
    env.MEDIA_STORAGE === 'gcs' || env.MEDIA_STORAGE === 'local' ? env.MEDIA_STORAGE : null;
  const bucket = env.GCS_BUCKET?.trim() || null;
  const explicit = env.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null;
  return {
    storage,
    bucket,
    credentialsBase64: env.GCS_CREDENTIALS_BASE64?.trim() || null,
    localDir: env.MEDIA_LOCAL_DIR?.trim() || '.media',
    publicBaseUrl:
      explicit ??
      (storage === 'gcs' && bucket
        ? `https://storage.googleapis.com/${bucket}`
        : storage === 'local'
          ? '/media'
          : null),
  };
}
