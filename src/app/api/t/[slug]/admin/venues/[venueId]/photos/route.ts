import { type NextRequest } from 'next/server';

import {
  assertCanAddPhoto,
  deleteObjectsQuietly,
  normaliseAlt,
  recordVenuePhoto,
  storeUpload,
  VenuePhotoError,
} from '@/app-layer/usecases/venue-photos';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { mediaBaseUrl, toPhotoView } from '@/lib/media/photo-view';
import { MAX_UPLOAD_BYTES } from '@/lib/media/limits';
import { getMediaStorage } from '@/lib/media/storage';
import { getRequestId } from '@/lib/observability/context';
import { MEDIA_UPLOAD_LIMIT } from '@/lib/security/rate-limit';

/**
 * Upload a venue's cover or a gallery photo (#366), from the club admin's
 * "Снимки и информация" screen. multipart/form-data: `file`, `alt` (required)
 * and `kind` (`cover` | `gallery`). Answers 201 with the photo.
 *
 * ═══ WHY A ROUTE AND NOT A SERVER ACTION ═══
 *
 * The rest of the screen is Server Actions (alt text, order, removal), the
 * admin's convention. An upload is not: a Server Action's body is parsed
 * before the action runs, so taking an 8 MB file would mean raising
 * `serverActions.bodySizeLimit` for EVERY action in the app, readable by
 * anyone who can post to a page. Here the caller is authenticated and
 * authorised (`admin.venue_manage`, the `/admin/venues` row of the permission
 * table, from the database role) BEFORE a byte of the body is read, and the
 * body is read with a hard cap rather than trusted to `Content-Length`.
 *
 * Unversioned (`/api/t/...`, not `/api/v1`): a web-admin surface the native
 * client does not call, like the other admin writes; the photos it produces
 * are on the v1 venue DTOs.
 *
 * Signed direct-to-GCS uploads were not chosen: the file must be decoded,
 * checked and re-encoded on the server anyway (EXIF, polyglots, bombs), so a
 * direct upload would only add a second hop and a bucket that accepts
 * unprocessed writes.
 */

/** The file plus the form's other fields and multipart framing. */
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

async function readCappedBody(req: NextRequest): Promise<Buffer> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new VenuePhotoError('TOO_LARGE');
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new VenuePhotoError('TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; venueId: string }> },
) {
  const { slug, venueId } = await params;
  // 401/403 (admin.venue_manage, from the database) before the body is read.
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  const storage = getMediaStorage();
  const base = mediaBaseUrl();
  if (!storage || !base) throw new VenuePhotoError('MEDIA_NOT_CONFIGURED');

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new VenuePhotoError('UNSUPPORTED_TYPE');
  }
  const body = await readCappedBody(req);
  let form: FormData;
  try {
    form = await new Request('http://upload.invalid/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new VenuePhotoError('UNREADABLE');
  }

  const kind = form.get('kind') === 'cover' ? 'COVER' : 'GALLERY';
  const alt = normaliseAlt(form.get('alt'));
  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0) throw new VenuePhotoError('UNREADABLE');
  if (file.size > MAX_UPLOAD_BYTES) throw new VenuePhotoError('TOO_LARGE');

  // The venue is this club's and has room: refused before any decode.
  await inTenant(ctx, (db) => assertCanAddPhoto(db, ctx.tenantId!, venueId, kind));

  const upload = await storeUpload(storage, venueId, Buffer.from(await file.arrayBuffer()));

  let result;
  try {
    result = await inTenant(ctx, (db) =>
      recordVenuePhoto(
        db,
        { tenantId: ctx.tenantId!, actorUserId: ctx.userId! },
        { venueId, kind, alt, upload, publicBaseUrl: base },
      ),
    );
  } catch (e) {
    // No row names these objects: delete them now rather than leave them to the sweep.
    await deleteObjectsQuietly(storage, upload.keys);
    throw e;
  }
  // The replaced cover's objects, after the commit.
  await deleteObjectsQuietly(storage, result.replacedKeys);

  return ok(toPhotoView(result.photo, base), { status: 201 });
}

export const POST = defineV1Route(handler, {
  rateLimit: { config: MEDIA_UPLOAD_LIMIT, scope: 'media-upload' },
});
