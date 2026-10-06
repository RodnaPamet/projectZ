import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertObjectKey, InvalidObjectKeyError, isObjectKey } from './keys';
import type { MediaStorage, StoredObject } from './storage';

/**
 * Venue photos on the local disk, for dev, tests, CI and the E2E build
 * (`MEDIA_STORAGE=local`). Never on the VM: a container's disk is gone on the
 * next deploy.
 *
 * Every key is checked against `OBJECT_KEY` and the resolved path must stay
 * under the root, so neither a crafted key nor a symlink-free `..` can reach
 * outside it.
 */
export class LocalMediaStorage implements MediaStorage {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  /** The file behind `key`, or throws InvalidObjectKeyError. */
  pathFor(key: string): string {
    assertObjectKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new InvalidObjectKeyError();
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(path.dirname(full), { recursive: true });
    // Immutable, as in the bucket: an existing name is never overwritten.
    const exists = await stat(full).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`Object already exists: ${key}`);
    // Write then rename, so a reader never sees half a file.
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, full);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      if (e instanceof InvalidObjectKeyError) throw e;
      return null;
    }
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) await rm(this.pathFor(key), { force: true });
  }

  async list(
    prefix: string,
    opts: { pageToken?: string; maxResults?: number } = {},
  ): Promise<{ items: StoredObject[]; nextPageToken: string | null }> {
    const base = path.resolve(this.root, prefix);
    if (base !== this.root && !base.startsWith(this.root + path.sep)) {
      throw new InvalidObjectKeyError();
    }
    const items: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = path.relative(this.root, full).split(path.sep).join('/');
          if (!isObjectKey(key) || !key.startsWith(prefix)) continue;
          items.push({ key, createdAt: (await stat(full)).mtime });
        }
      }
    };
    // `prefix` may end mid-name; walk its directory.
    await walk(prefix.endsWith('/') ? base : path.dirname(base));
    items.sort((a, b) => a.key.localeCompare(b.key));
    const start = opts.pageToken ? Number(opts.pageToken) : 0;
    const size = opts.maxResults ?? 1000;
    const page = items.slice(start, start + size);
    return {
      items: page,
      nextPageToken: start + size < items.length ? String(start + size) : null,
    };
  }
}
