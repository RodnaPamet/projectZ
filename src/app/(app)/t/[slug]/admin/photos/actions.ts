'use server';

import { revalidatePath } from 'next/cache';

import {
  deleteObjectsQuietly,
  deleteVenuePhoto,
  moveGalleryPhoto,
  updatePhotoAlt,
  VenuePhotoError,
  type VenuePhotoErrorCode,
} from '@/app-layer/usecases/venue-photos';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { getMediaStorage } from '@/lib/media/storage';

/**
 * The photo screen's small writes (#366): alt text, gallery order, removal.
 * The upload itself is a route, `POST /api/t/{slug}/admin/venues/{id}/photos`,
 * for the body-size reason its header gives.
 *
 * Every action authorises itself first (`admin.venue_manage`, OWNER and
 * MANAGER), as the courts actions explain; the use case binds the tenant, so
 * a photo id from another club is "not found". A refusal comes back as its
 * code, which the board turns into a sentence.
 */

export type PhotoActionResult = { ok: true } | { ok: false; error: VenuePhotoErrorCode };

/** Run a write; a refusal becomes its code, and a success refreshes the screen. */
async function settle(slug: string, fn: () => Promise<void>): Promise<PhotoActionResult> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof VenuePhotoError) return { ok: false, error: e.reason };
    throw e;
  }
  revalidatePath(`/t/${slug}/admin/photos`);
  return { ok: true };
}

export async function updatePhotoAltAction(
  slug: string,
  photoId: string,
  _prev: PhotoActionResult | null,
  form: FormData,
): Promise<PhotoActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.venue_manage');
  const actor = { tenantId: ctx.tenantId, actorUserId: ctx.userId };
  return settle(slug, () =>
    runInTenantContext(ctx.tenantId, (db) => updatePhotoAlt(db, actor, photoId, form.get('alt'))),
  );
}

export async function movePhotoAction(
  slug: string,
  photoId: string,
  direction: 'up' | 'down',
): Promise<PhotoActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.venue_manage');
  const actor = { tenantId: ctx.tenantId, actorUserId: ctx.userId };
  return settle(slug, () =>
    runInTenantContext(ctx.tenantId, (db) =>
      moveGalleryPhoto(db, actor, photoId, direction === 'up' ? 'up' : 'down'),
    ),
  );
}

export async function deletePhotoAction(slug: string, photoId: string): Promise<PhotoActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.venue_manage');
  const actor = { tenantId: ctx.tenantId, actorUserId: ctx.userId };
  return settle(slug, async () => {
    const keys = await runInTenantContext(ctx.tenantId, (db) =>
      deleteVenuePhoto(db, actor, photoId),
    );
    // After the commit; a failure is left to the orphan sweep.
    await deleteObjectsQuietly(getMediaStorage(), keys);
  });
}
