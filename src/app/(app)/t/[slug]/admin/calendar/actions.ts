'use server';

import { revalidatePath } from 'next/cache';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  markNoShow,
  NoShowRefusedError,
  type NoShowRefusal,
} from '@/app-layer/usecases/booking-outcome';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { loadDiaryDay } from './diary-day';

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

/**
 * The diary's stale-data refresh (#314): the same day, built again, handed
 * back as data for the grid to swap in.
 *
 * ═══ A READ, AND IT MUST STAY ONE ═══
 *
 * It replaced `router.refresh()`, which purged the WHOLE client router cache
 * on every stale revisit, taking every other warm admin screen with it. This
 * action keeps the cache intact only because it changes nothing the router
 * can see. In Next 16.3.6 an action response carries `x-action-revalidated`
 * when it called `revalidatePath`/`revalidateTag`/`refresh()` or set a cookie
 * (server/app-render/action-handler.js `addRevalidationHeader`), and the
 * client's server-action reducer then evicts the BFCache and, for a tag or
 * cookie, the entire prefetch cache. With no revalidation, no redirect and no
 * page render (`skipPageRendering`), the reducer returns the router state
 * unchanged. So: no revalidatePath here, no cookie writes, no redirect — the
 * guardrail in tests/guardrails/router-cache-policy.test.ts holds it to that.
 *
 * `bookings.view_all`, as the page itself requires. A caller without it gets
 * the action's refusal, which the grid treats as "keep what is on screen".
 */
export async function refreshDiaryDayAction(slug: string, requestedDay: string | null) {
  const ctx = await requireTenantAction(slug, 'bookings.view_all');
  const [t, locale] = await Promise.all([getTranslations('admin.calendar'), getLocale()]);
  return loadDiaryDay(ctx.tenantId, typeof requestedDay === 'string' ? requestedDay : null, {
    locale,
    labels: { unknownPlayer: t('unknownPlayer'), guest: t('guest') },
  });
}
