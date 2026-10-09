import type { PrismaClient } from '@prisma/client';

import { AVATAR_KEY, avatarPrefix } from './keys';
import type { MediaStorage } from './storage';

/**
 * Deleting profile pictures' copies (#458): one account's, when it is deleted
 * (#370), and every copy no live account names, daily. Storage only, no image
 * library, so account deletion and the sweep load nothing heavy.
 */

/**
 * Every copy of one account's picture (account deletion, #370): returns how
 * many went. Throws when storage does; the caller decides what that means.
 */
export async function purgeAvatarObjects(storage: MediaStorage, userId: string): Promise<number> {
  const prefix = avatarPrefix(userId);
  let deleted = 0;
  let pageToken: string | undefined;
  do {
    const page = await storage.list(prefix, { pageToken, maxResults: 100 });
    await storage.deleteMany(page.items.map((i) => i.key));
    deleted += page.items.length;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return deleted;
}

/** Objects younger than this may belong to a sign-in still saving its key. */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The daily job's second half: delete every picture under `avatars/` that no
 * live account names and that is a day old. That covers an old copy whose
 * delete failed, a copy whose key was never saved, and a deleted account
 * whose purge failed. Takes a BYPASSRLS handle: it spans every account, and
 * reads only `avatarUrl` and `deletedAt`.
 */
export async function sweepOrphanAvatars(
  db: PrismaClient,
  storage: MediaStorage,
  opts: { now?: Date; minAgeMs?: number; maxObjects?: number } = {},
): Promise<{ scanned: number; deleted: number; truncated: boolean }> {
  const cutoff = (opts.now ?? new Date()).getTime() - (opts.minAgeMs ?? ORPHAN_MIN_AGE_MS);
  const maxObjects = opts.maxObjects ?? 10_000;
  let scanned = 0;
  let deleted = 0;
  let pageToken: string | undefined;
  do {
    const page = await storage.list('avatars/', { pageToken, maxResults: 500 });
    scanned += page.items.length;
    // A name that is not a picture's (not ours) is left alone.
    const old = page.items.filter((i) => AVATAR_KEY.test(i.key) && i.createdAt.getTime() < cutoff);
    const ids = [...new Set(old.map((i) => i.key.split('/')[1]!))];
    // guardrail-allow: n-plus-one — one query per PAGE of 500 objects listed
    // from storage, not per object; the loop is the pager.
    const named = await namedPictures(db, ids);
    const orphans = old.filter((i) => !named.has(i.key));
    if (orphans.length > 0) {
      await storage.deleteMany(orphans.map((o) => o.key));
      deleted += orphans.length;
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && scanned < maxObjects);
  return { scanned, deleted, truncated: !!pageToken };
}

/** The pictures the live accounts among `ids` name, in one query. */
async function namedPictures(db: PrismaClient, ids: string[]): Promise<Set<string | null>> {
  if (ids.length === 0) return new Set();
  const rows = await db.user.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { avatarUrl: true },
    take: ids.length,
  });
  return new Set(rows.map((r) => r.avatarUrl));
}
