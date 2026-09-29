'use server';

import { revalidatePath } from 'next/cache';

import {
  markNoShow,
  NoShowRefusedError,
  type NoShowRefusal,
} from '@/app-layer/usecases/booking-outcome';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * Diary mutations.
 *
 * ═══ WHY `bookings.view_all` ═══
 *
 * Marking a no-show is staff acting on a PLAYER's booking, and that is what
 * `bookings.view_all` already means on the cancel route: it is the permission
 * that lets the desk act on somebody else's reservation. STAFF, MANAGER and
 * OWNER hold it; COACH and PLAYER do not.
 *
 * `bookings.cancel` would be the wrong one precisely because it sounds right.
 * Every PLAYER holds it — cancelling your own booking is ordinary — so gating
 * this on it would let any member of the club mark any other member absent,
 * and increment their no-show count, by posting this action directly.
 */

type ActionResult = { ok: true } | { ok: false; error: NoShowRefusal };

export async function markNoShowAction(slug: string, bookingId: string): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'bookings.view_all');

  try {
    await runInTenantContext(ctx.tenantId, (db) =>
      markNoShow(db, ctx.tenantId, { bookingId, actorUserId: ctx.userId }),
    );
  } catch (err) {
    // Every refusal is a rule the diary could not show in advance — the sweep
    // or the player may have moved the booking since the page rendered — so it
    // becomes a message, not an error boundary. Anything else still throws.
    if (err instanceof NoShowRefusedError) return { ok: false, error: err.reason };
    throw err;
  }

  revalidatePath(`/t/${slug}/admin/calendar`);
  return { ok: true };
}
