'use server';

import { revalidatePath } from 'next/cache';

import {
  ClubInfoError,
  updateClubDescription,
  updateVenueInfo,
  type ClubInfoErrorCode,
} from '@/app-layer/usecases/club-info';
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

// ─── «Информация» (#530): the club's description; a venue's description and phone ───

export type InfoActionResult = { ok: true } | { ok: false; error: ClubInfoErrorCode };

/** As `settle`, for the info writes; the club's and the venue's public pages change too. */
async function settleInfo(slug: string, fn: () => Promise<void>): Promise<InfoActionResult> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ClubInfoError) return { ok: false, error: e.reason };
    throw e;
  }
  revalidatePath(`/t/${slug}/admin/photos`);
  return { ok: true };
}

export async function saveClubDescriptionAction(
  slug: string,
  _prev: InfoActionResult | null,
  form: FormData,
): Promise<InfoActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.venue_manage');
  const actor = { tenantId: ctx.tenantId, actorUserId: ctx.userId };
  return settleInfo(slug, () =>
    runInTenantContext(ctx.tenantId, (db) =>
      updateClubDescription(db, actor, form.get('description')),
    ),
  );
}

export async function saveVenueInfoAction(
  slug: string,
  venueId: string,
  _prev: InfoActionResult | null,
  form: FormData,
): Promise<InfoActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.venue_manage');
  const actor = { tenantId: ctx.tenantId, actorUserId: ctx.userId };
  return settleInfo(slug, () =>
    runInTenantContext(ctx.tenantId, (db) =>
      updateVenueInfo(db, actor, venueId, {
        description: form.get('description'),
        phone: form.get('phone'),
      }),
    ),
  );
}
