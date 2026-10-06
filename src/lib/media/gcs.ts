import type { Bucket } from '@google-cloud/storage';

import { assertObjectKey } from './keys';
import type { MediaStorage, StoredObject } from './storage';

/**
 * Venue photos in Google Cloud Storage (`MEDIA_STORAGE=gcs`): the bucket in
 * `hazel-design-419410`, europe-west1, beside the VM (docs/media-storage.md).
 *
 * ═══ CREDENTIALS ═══
 *
 * Application Default Credentials unless `GCS_CREDENTIALS_BASE64` is set.
 * On the VM it has to be: the VM's default service account carries the
 * `devstorage.read_only` ACCESS SCOPE, which caps its token whatever IAM
 * grants, and widening a scope means stopping the VM (and agrent with it).
 * That account is also a project Editor, so widening it would hand this
 * container every bucket in the project, the database backups included. A
 * dedicated account with `roles/storage.objectAdmin` on this bucket only is
 * the narrower grant; the doc has the commands.
 *
 * ═══ WRITES ARE CREATE-ONLY ═══
 *
 * `ifGenerationMatch: 0` makes GCS refuse to overwrite an existing name, so
 * an object behind a public, year-long cached URL can never change.
 *
 * The client library is imported on first use: a page render that never
 * uploads does not load it.
 */
export class GcsMediaStorage implements MediaStorage {
  readonly kind = 'gcs' as const;
  private bucketPromise: Promise<Bucket> | null = null;

  constructor(
    private readonly bucketName: string,
    private readonly credentialsBase64: string | null,
  ) {}

  private bucket(): Promise<Bucket> {
    this.bucketPromise ??= import('@google-cloud/storage').then(({ Storage }) => {
      const credentials = this.credentialsBase64
        ? (JSON.parse(Buffer.from(this.credentialsBase64, 'base64').toString('utf8')) as {
            client_email: string;
            private_key: string;
            project_id?: string;
          })
        : undefined;
      const storage = new Storage(
        credentials ? { credentials, projectId: credentials.project_id } : {},
      );
      return storage.bucket(this.bucketName);
    });
    return this.bucketPromise;
  }

  async put(
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl: string },
  ): Promise<void> {
    assertObjectKey(key);
    const bucket = await this.bucket();
    await bucket.file(key).save(body, {
      resumable: false,
      contentType: opts.contentType,
      metadata: { cacheControl: opts.cacheControl, contentDisposition: 'inline' },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    const bucket = await this.bucket();
    for (const key of keys) {
      await bucket.file(assertObjectKey(key)).delete({ ignoreNotFound: true });
    }
  }

  async list(
    prefix: string,
    opts: { pageToken?: string; maxResults?: number } = {},
  ): Promise<{ items: StoredObject[]; nextPageToken: string | null }> {
    const bucket = await this.bucket();
    const [files, next] = await bucket.getFiles({
      prefix,
      autoPaginate: false,
      maxResults: opts.maxResults ?? 1000,
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    });
    return {
      items: files.map((f) => ({
        key: f.name,
        createdAt: new Date(f.metadata.timeCreated ?? 0),
      })),
      nextPageToken: (next as { pageToken?: string } | null)?.pageToken ?? null,
    };
  }
}
