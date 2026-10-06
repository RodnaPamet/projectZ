import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { AppError } from '@/lib/errors/types';
import {
  IMMUTABLE_CACHE_CONTROL,
  newObjectStem,
  OBJECT_STEM,
  renditionKey,
  renditionKeys,
  stemOf,
  venuePrefix,
} from '@/lib/media/keys';
import { DEFAULT_WIDTH } from '@/lib/media/limits';
import { PHOTO_SELECT, toPhotoView, type PhotoRow } from '@/lib/media/photo-view';
import type { MediaStorage } from '@/lib/media/storage';
import { logger } from '@/lib/observability/logger';

/**
 * A venue's cover and gallery (#366): upload, alt text, order, removal, and
 * the clean-up of the objects behind them.
 *
 * ═══ THE CALLER BINDS ═══
 *
 * Every function that touches rows takes `db` and a `tenantId`, bound by the
 * caller with `runInTenantContext`: `venue_photo` and `venue` are FORCE row
 * security, so another club's venue or photo is simply not found, and the
 * explicit `tenantId` in every WHERE is belt and braces. The admin holds
 * `admin.venue_manage` (OWNER, MANAGER); the route and the actions check it.
 *
 * ═══ OBJECTS AND ROWS ═══
 *
 * Storage is not in the transaction, so the order is chosen so that a failure
 * can only ever leave an UNREFERENCED object, never a row pointing at nothing:
 *
 *   upload    objects first, then the row. A failed insert deletes the
 *             objects it just wrote.
 *   replace   the old cover's row goes in the same transaction as the new
 *             one's; its objects are deleted after the commit.
 *   delete    the row first; the objects after the commit.
 *
 * A delete after a commit that fails (storage down) is logged and left to
 * `sweepOrphanMedia`, the daily job that deletes any object no row names.
 * The same sweep is what cleans up after a venue or a club is removed:
 * `venue_photo` cascades with its venue, and the next sweep deletes the
 * objects. `purgeVenueMedia` does it at once for a removal path that wants to.
 */

export const MAX_GALLERY_PHOTOS = 12;
export const MAX_ALT_LENGTH = 200;
/** How old an unreferenced object must be before the sweep deletes it. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type VenuePhotoErrorCode =
  | 'VENUE_NOT_FOUND'
  | 'PHOTO_NOT_FOUND'
  | 'ALT_REQUIRED'
  | 'ALT_TOO_LONG'
  | 'GALLERY_FULL'
  | 'MEDIA_NOT_CONFIGURED'
  | 'UNSUPPORTED_TYPE'
  | 'TOO_LARGE'
  | 'TOO_MANY_PIXELS'
  | 'TOO_SMALL'
  | 'UNREADABLE';

const STATUS: Record<VenuePhotoErrorCode, number> = {
  VENUE_NOT_FOUND: 404,
  PHOTO_NOT_FOUND: 404,
  ALT_REQUIRED: 400,
  ALT_TOO_LONG: 400,
  GALLERY_FULL: 409,
  MEDIA_NOT_CONFIGURED: 503,
  UNSUPPORTED_TYPE: 415,
  TOO_LARGE: 413,
  TOO_MANY_PIXELS: 413,
  TOO_SMALL: 422,
  UNREADABLE: 422,
};

/**
 * Every refusal here. Another club's venue or photo is the same 404 as one
 * that does not exist: telling them apart turns an id into a cross-club probe.
 */
export class VenuePhotoError extends AppError {
  constructor(readonly reason: VenuePhotoErrorCode) {
    super(`Venue photo: ${reason}`, reason, STATUS[reason], true);
    this.name = 'VenuePhotoError';
  }
}

/**
 * Alt text as stored: control characters out, whitespace collapsed, 1..200
 * characters. Plain text: React escapes it on the page and serializeJsonLd in
 * the structured data, so markup in it is shown, never run.
 */
export function normaliseAlt(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const clean = text.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
    ' ',
  );
  const alt = clean.replace(/\s+/g, ' ').trim();
  if (alt.length === 0) throw new VenuePhotoError('ALT_REQUIRED');
  if (alt.length > MAX_ALT_LENGTH) throw new VenuePhotoError('ALT_TOO_LONG');
  return alt;
}

interface Actor {
  tenantId: string;
  actorUserId: string;
}

// ─── Reads ────────────────────────────────────────────────────────────

/** The admin screen: every live venue of the club with its photos. */
export async function loadPhotosScreen(db: PrismaClient, tenantId: string) {
  const venues = await db.venue.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      publicSlug: true,
      photos: {
        select: PHOTO_SELECT,
        orderBy: [{ kind: 'asc' }, { position: 'asc' }],
        take: MAX_GALLERY_PHOTOS + 1,
      },
    },
    orderBy: { name: 'asc' },
    take: 50,
  });
  return venues.map((v) => {
    const cover = v.photos.find((p) => p.kind === 'COVER');
    return {
      id: v.id,
      name: v.name,
      publicSlug: v.publicSlug,
      cover: cover ? toPhotoView(cover) : null,
      gallery: v.photos.filter((p) => p.kind === 'GALLERY').map((p) => toPhotoView(p)),
    };
  });
}

async function lockVenue(db: PrismaClient, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true, name: true },
  });
  if (!venue) throw new VenuePhotoError('VENUE_NOT_FOUND');
  // Serialises uploads and reorders on one venue: the gallery cap and the
  // positions are read-then-write.
  // public-venue-filter: not a public read — a row lock on this club's own
  // venue, found by the tenant-bound read above, under the tenant binding.
  await db.$executeRaw`SELECT 1 FROM "venue" WHERE "id" = ${venueId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  return venue;
}

/** Fail fast, before an upload is decoded: the venue is ours and has room. */
export async function assertCanAddPhoto(
  db: PrismaClient,
  tenantId: string,
  venueId: string,
  kind: 'COVER' | 'GALLERY',
): Promise<void> {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  });
  if (!venue) throw new VenuePhotoError('VENUE_NOT_FOUND');
  if (kind === 'GALLERY') {
    const n = await db.venuePhoto.count({ where: { tenantId, venueId, kind: 'GALLERY' } });
    if (n >= MAX_GALLERY_PHOTOS) throw new VenuePhotoError('GALLERY_FULL');
  }
}

// ─── Upload ───────────────────────────────────────────────────────────

export interface StoredUpload {
  stem: string;
  widths: number[];
  width: number;
  height: number;
  blurDataUrl: string;
  /** Every object written, for a rollback. */
  keys: string[];
}

/**
 * Decode, resize and store one upload under `venues/{venueId}/`. Writes the
 * objects only; `recordVenuePhoto` writes the row. Throws VenuePhotoError for
 * every refusal of the file itself.
 */
export async function storeUpload(
  storage: MediaStorage,
  venueId: string,
  file: Buffer,
): Promise<StoredUpload> {
  // Imported here, not at the top: sharp (a native module) loads only when
  // somebody uploads, never for the admin page or the public venue reads.
  const { ImageRejectedError, processUpload } = await import('@/lib/media/image');
  let processed;
  try {
    processed = await processUpload(file);
  } catch (e) {
    if (e instanceof ImageRejectedError) throw new VenuePhotoError(e.reason);
    throw e;
  }
  const stem = newObjectStem(venueId);
  const written: string[] = [];
  try {
    for (const r of processed.renditions) {
      const key = renditionKey(stem, r.width);
      await storage.put(key, r.body, {
        contentType: 'image/webp',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
      written.push(key);
    }
  } catch (e) {
    await deleteObjectsQuietly(storage, written);
    throw e;
  }
  const largest = processed.renditions[processed.renditions.length - 1]!;
  return {
    stem,
    widths: processed.renditions.map((r) => r.width),
    width: largest.width,
    height: largest.height,
    blurDataUrl: processed.blurDataUrl,
    keys: written,
  };
}

/** The URL kept in the legacy `url` column: the default rendition's. */
function defaultUrl(base: string, upload: StoredUpload): string {
  const w = [...upload.widths].reverse().find((x) => x <= DEFAULT_WIDTH) ?? upload.widths[0]!;
  return `${base}/${renditionKey(upload.stem, w)}`;
}

/**
 * The row for a stored upload. A cover replaces the venue's cover in the same
 * transaction; the replaced photo's object keys are returned for deletion
 * AFTER the caller's commit.
 */
export async function recordVenuePhoto(
  db: PrismaClient,
  actor: Actor,
  input: {
    venueId: string;
    kind: 'COVER' | 'GALLERY';
    alt: string;
    upload: StoredUpload;
    publicBaseUrl: string;
  },
): Promise<{ photo: PhotoRow; replacedKeys: string[] }> {
  const { tenantId, actorUserId } = actor;
  const venue = await lockVenue(db, tenantId, input.venueId);

  let replaced: PhotoRow | null = null;
  let position = 0;
  if (input.kind === 'COVER') {
    replaced = await db.venuePhoto.findFirst({
      where: { tenantId, venueId: venue.id, kind: 'COVER' },
      select: PHOTO_SELECT,
    });
    if (replaced) await db.venuePhoto.delete({ where: { id: replaced.id } });
  } else {
    const gallery = await db.venuePhoto.findMany({
      where: { tenantId, venueId: venue.id, kind: 'GALLERY' },
      select: { position: true },
      orderBy: { position: 'desc' },
      take: MAX_GALLERY_PHOTOS,
    });
    if (gallery.length >= MAX_GALLERY_PHOTOS) throw new VenuePhotoError('GALLERY_FULL');
    position = gallery.length > 0 ? gallery[0]!.position + 1 : 0;
  }

  const url = defaultUrl(input.publicBaseUrl, input.upload);
  const photo = await db.venuePhoto.create({
    data: {
      tenantId,
      venueId: venue.id,
      kind: input.kind,
      url,
      alt: input.alt,
      position,
      objectKey: input.upload.stem,
      widths: input.upload.widths,
      width: input.upload.width,
      height: input.upload.height,
      blurDataUrl: input.upload.blurDataUrl,
    },
    select: PHOTO_SELECT,
  });

  if (input.kind === 'COVER') {
    // Kept for every reader that still knows only the URL column (P05).
    await db.venue.update({ where: { id: venue.id }, data: { coverPhotoUrl: url } });
  }

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'VenuePhoto',
    entityId: photo.id,
    action: AUDIT_ACTIONS.VENUE_PHOTO_ADDED,
    details: `${input.kind === 'COVER' ? 'Cover' : 'Gallery photo'} added to "${venue.name}"`,
    detailsJson: {
      category: 'config',
      summary: input.kind === 'COVER' ? 'Venue cover set' : 'Venue gallery photo added',
      venueId: venue.id,
      after: auditView(photo),
      ...(replaced ? { before: auditView(replaced) } : {}),
    },
  });

  return { photo, replacedKeys: replaced ? keysOf(replaced) : [] };
}

// ─── Edits ────────────────────────────────────────────────────────────

async function findPhoto(db: PrismaClient, tenantId: string, photoId: string) {
  const photo = await db.venuePhoto.findFirst({
    where: { id: photoId, tenantId },
    select: { ...PHOTO_SELECT, venueId: true, venue: { select: { name: true } } },
  });
  if (!photo) throw new VenuePhotoError('PHOTO_NOT_FOUND');
  return photo;
}

export async function updatePhotoAlt(
  db: PrismaClient,
  actor: Actor,
  photoId: string,
  rawAlt: unknown,
): Promise<void> {
  const alt = normaliseAlt(rawAlt);
  const before = await findPhoto(db, actor.tenantId, photoId);
  if (before.alt === alt) return;
  await db.venuePhoto.update({ where: { id: before.id }, data: { alt } });
  await appendAuditEntry(db, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    entity: 'VenuePhoto',
    entityId: before.id,
    action: AUDIT_ACTIONS.VENUE_PHOTO_ALT_CHANGED,
    details: `Photo description changed at "${before.venue.name}"`,
    detailsJson: {
      category: 'config',
      summary: 'Venue photo description changed',
      venueId: before.venueId,
      before: { alt: before.alt },
      after: { alt },
    },
  });
}

/** Move a gallery photo one place earlier or later. A no-op at either end. */
export async function moveGalleryPhoto(
  db: PrismaClient,
  actor: Actor,
  photoId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const photo = await findPhoto(db, actor.tenantId, photoId);
  if (photo.kind !== 'GALLERY') throw new VenuePhotoError('PHOTO_NOT_FOUND');
  await lockVenue(db, actor.tenantId, photo.venueId);

  const gallery = await db.venuePhoto.findMany({
    where: { tenantId: actor.tenantId, venueId: photo.venueId, kind: 'GALLERY' },
    select: { id: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: MAX_GALLERY_PHOTOS,
  });
  const ids = gallery.map((g) => g.id);
  const from = ids.indexOf(photo.id);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  await writePositions(db, ids);

  await appendAuditEntry(db, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    entity: 'VenuePhoto',
    entityId: photo.id,
    action: AUDIT_ACTIONS.VENUE_PHOTO_MOVED,
    details: `Gallery reordered at "${photo.venue.name}"`,
    detailsJson: {
      category: 'config',
      summary: 'Venue gallery reordered',
      venueId: photo.venueId,
      before: { position: from },
      after: { position: to },
    },
  });
}

/** Positions 0..n-1 in the given order. A handful of rows, one update each. */
async function writePositions(db: PrismaClient, ids: readonly string[]): Promise<void> {
  for (const [position, id] of ids.entries()) {
    await db.venuePhoto.update({ where: { id }, data: { position } });
  }
}

/**
 * Remove a photo (the cover, or one of the gallery). Returns its object keys
 * for the caller to delete AFTER the commit.
 */
export async function deleteVenuePhoto(
  db: PrismaClient,
  actor: Actor,
  photoId: string,
): Promise<string[]> {
  const photo = await findPhoto(db, actor.tenantId, photoId);
  await lockVenue(db, actor.tenantId, photo.venueId);
  await db.venuePhoto.delete({ where: { id: photo.id } });

  if (photo.kind === 'COVER') {
    await db.venue.update({ where: { id: photo.venueId }, data: { coverPhotoUrl: null } });
  } else {
    const rest = await db.venuePhoto.findMany({
      where: { tenantId: actor.tenantId, venueId: photo.venueId, kind: 'GALLERY' },
      select: { id: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: MAX_GALLERY_PHOTOS,
    });
    await writePositions(
      db,
      rest.map((r) => r.id),
    );
  }

  await appendAuditEntry(db, {
    tenantId: actor.tenantId,
    actorUserId: actor.actorUserId,
    entity: 'VenuePhoto',
    entityId: photo.id,
    action: AUDIT_ACTIONS.VENUE_PHOTO_DELETED,
    details: `${photo.kind === 'COVER' ? 'Cover' : 'Gallery photo'} removed from "${photo.venue.name}"`,
    detailsJson: {
      category: 'config',
      summary: photo.kind === 'COVER' ? 'Venue cover removed' : 'Venue gallery photo removed',
      venueId: photo.venueId,
      before: auditView(photo),
    },
  });

  return keysOf(photo);
}

// ─── Objects ──────────────────────────────────────────────────────────

function keysOf(row: Pick<PhotoRow, 'objectKey' | 'widths'>): string[] {
  return row.objectKey && OBJECT_STEM.test(row.objectKey)
    ? renditionKeys(row.objectKey, row.widths)
    : [];
}

function auditView(row: PhotoRow) {
  return {
    id: row.id,
    kind: row.kind,
    alt: row.alt,
    objectKey: row.objectKey,
    widths: row.widths,
  };
}

/**
 * Delete objects after a commit. A failure is logged, not thrown: the change
 * the person made has happened, and the orphan sweep deletes what is left.
 */
export async function deleteObjectsQuietly(
  storage: MediaStorage | null,
  keys: readonly string[],
): Promise<void> {
  if (!storage || keys.length === 0) return;
  try {
    await storage.deleteMany(keys);
  } catch (e) {
    logger.warn('venue photo objects not deleted; the orphan sweep will retry', {
      component: 'media',
      count: keys.length,
      error: e instanceof Error ? { name: e.name, message: e.message } : undefined,
    });
  }
}

/**
 * Delete every object of one venue at once. For a venue- or club-removal
 * path, run AFTER its delete commits (the rows cascade with the venue).
 * Without it the daily sweep does the same a day later.
 */
export async function purgeVenueMedia(storage: MediaStorage, venueId: string): Promise<number> {
  const prefix = venuePrefix(venueId);
  let deleted = 0;
  let pageToken: string | undefined;
  do {
    const page = await storage.list(prefix, { pageToken, maxResults: 500 });
    await storage.deleteMany(page.items.map((i) => i.key));
    deleted += page.items.length;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return deleted;
}

/**
 * The daily job: delete every object under `venues/` that no `venue_photo`
 * row names and that is older than `minAgeMs` (an upload in flight has
 * written its objects but not yet its row). Takes a BYPASSRLS handle: it
 * spans every club, and reads only `objectKey`.
 */
export async function sweepOrphanMedia(
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
    const page = await storage.list('venues/', { pageToken, maxResults: 500 });
    scanned += page.items.length;
    const old = page.items.filter((i) => i.createdAt.getTime() < cutoff);
    const stems = [...new Set(old.map((i) => stemOf(i.key)).filter((s): s is string => !!s))];
    // guardrail-allow: n-plus-one — one query per PAGE of 500 objects listed
    // from storage, not per object; the loop is the pager.
    const known = await referencedStems(db, stems);
    // A key that is not a rendition name at all (not ours) is left alone.
    const orphans = old.filter((i) => {
      const stem = stemOf(i.key);
      return stem !== null && !known.has(stem);
    });
    if (orphans.length > 0) {
      await storage.deleteMany(orphans.map((o) => o.key));
      deleted += orphans.length;
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && scanned < maxObjects);
  return { scanned, deleted, truncated: !!pageToken };
}

/** Which of `stems` a `venue_photo` row still names, in one query. */
async function referencedStems(db: PrismaClient, stems: string[]): Promise<Set<string | null>> {
  if (stems.length === 0) return new Set();
  // guardrail-allow: cross-tenant — the sweep spans every club's objects and
  // reads only which stems are still referenced.
  const rows = await db.venuePhoto.findMany({
    where: { objectKey: { in: stems } },
    select: { objectKey: true },
    take: stems.length,
  });
  return new Set(rows.map((r) => r.objectKey));
}
