import type { NotificationKind, PrismaClient } from '@prisma/client';

import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';
import { resolveLocale } from '@/lib/i18n/locales';
import { formatMoneyFor, translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';
import { sendApns } from '@/lib/push/apns';
import { sendPush } from '@/lib/push/send';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * The notification centre.
 *
 * ─── PERSIST, THEN PUSH. Never the other way round. ──────────────────
 *
 * The DATABASE ROW is the notification. Push is a delivery mechanism on top of
 * it — exactly the relationship Centrifugo has to a chat message (P15).
 *
 * Push-then-persist looks equivalent and is not: the banner appears on the
 * user's phone, the database write then fails, and the notification is nowhere
 * to be found when they open the app. They saw it. It does not exist. That is
 * far worse than a notification that arrives a second late.
 *
 * And because delivery is secondary, a dead push endpoint must NOT fail the
 * write. The row is there; they will see it when they next open the app.
 */

export const NOTIFICATION_TITLE_MAX = 80;
export const NOTIFICATION_BODY_MAX = 200;

export interface NotifyInput {
  tenantId?: string | null;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string;
  refType?: string;
  refId?: string;
}

/**
 * Create a notification and try to push it.
 *
 * Takes a handle bound to the RECIPIENT — `notification`, `push_subscription`
 * and `device_token` are all owner-only on `app.user_id`. Most callers want
 * `notifyAfterCommit`, which binds it for them.
 */
export async function notify(
  db: PrismaClient,
  input: NotifyInput,
): Promise<{ id: string; pushed: number }> {
  // Sanitised on the way IN. A notification body is rendered in the centre, and
  // a title can come from user-supplied text (a venue name, a player's display
  // name).
  const title = sanitizePlainText(input.title).slice(0, NOTIFICATION_TITLE_MAX);
  const body = sanitizePlainText(input.body).slice(0, NOTIFICATION_BODY_MAX);

  // ── 1. PERSIST ────────────────────────────────────────────────────
  const notification = await db.notification.create({
    data: {
      tenantId: input.tenantId ?? null,
      userId: input.userId,
      kind: input.kind,
      title,
      body,
      href: input.href ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
    },
  });

  // ── 2. THEN PUSH (best-effort) ────────────────────────────────────
  const pushed = await pushToAllDevices(db, {
    userId: input.userId,
    payload: {
      title,
      body,
      url: input.href ?? '/',
      // Same tag → the new notification REPLACES the old one on the lock screen
      // rather than stacking. Three reminders about one booking is three
      // reminders too many.
      tag: input.refId ? `${input.refType}:${input.refId}` : undefined,
    },
  });

  return { id: notification.id, pushed };
}

/**
 * Push to every device the user has, and REAP the dead ones.
 *
 * A person has a phone and a laptop; both should buzz. A subscription that
 * returns 404/410 is permanently gone — the browser was cleared, the PWA
 * uninstalled, permission revoked — and retrying it forever backs the queue up
 * behind endpoints that will never accept anything again.
 */
async function pushToAllDevices(
  db: PrismaClient,
  input: { userId: string; payload: { title: string; body: string; url?: string; tag?: string } },
): Promise<number> {
  // guardrail-allow: cross-tenant — a notification and a push subscription belong
  // to a PERSON, not to a club. They are protected per-USER by the owner-only RLS
  // policy on app.user_id (same shape as wearables, P20); a tenant filter would
  // be the wrong boundary entirely, since everyone at a club shares a tenant.
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: input.userId },
    take: 20,
  });

  let delivered = 0;
  const dead: string[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await sendPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        input.payload,
      );

      if (result.ok) {
        delivered++;
        await db.pushSubscription.update({
          where: { id: sub.id },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        });
        return;
      }

      if (result.gone) {
        dead.push(sub.id);
        return;
      }

      // Transient. Count it, but keep the subscription — deleting on a 500 would
      // silently unsubscribe a user whose push service had a bad afternoon, and
      // they would never find out why their notifications stopped.
      await db.pushSubscription.update({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
      });
    }),
  );

  if (dead.length > 0) {
    await db.pushSubscription.deleteMany({ where: { id: { in: dead } } });
  }

  // ═══ THE SAME NOTIFICATION, TO APNs DEVICES ═══
  //
  // A person can have both: the PWA in a browser and the native app on a
  // phone. Both are registrations of theirs and both should ring, so this is a
  // second fan-out rather than a fallback — choosing one transport would mean
  // silently dropping the other's devices.
  //
  // The outcome shape is identical on purpose (see lib/push/apns.ts), so the
  // handling below mirrors the Web Push loop line for line: success clears the
  // failure count, `gone` deletes, and anything else counts a strike and keeps
  // the row.
  const devices = await db.deviceToken.findMany({
    where: { userId: input.userId },
    take: 20,
  });

  const deadDevices: string[] = [];

  await Promise.all(
    devices.map(async (device) => {
      const result = await sendApns(
        {
          deviceToken: device.deviceToken,
          bundleId: device.bundleId,
          environment: device.environment,
        },
        {
          title: input.payload.title,
          body: input.payload.body,
          url: input.payload.url,
          threadId: input.payload.tag,
        },
      );

      if (result.ok) {
        delivered++;
        await db.deviceToken.update({
          where: { id: device.id },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        });
        return;
      }

      if (result.gone) {
        // Apple says THIS TOKEN is dead: the app was deleted or the token was
        // reissued. It will never accept anything again.
        //
        // Deliberately no longer includes "or it belongs to the other
        // environment". A wrong environment is OUR bookkeeping error, and
        // deleting a live registration over it was the bug — `devices/route.ts`
        // now refuses to guess the environment rather than defaulting it.
        deadDevices.push(device.id);
        return;
      }

      if (result.configError) {
        // WE are misconfigured — a topic this key may not use, a key for the
        // wrong APNs environment, or a signing key that will not parse. The
        // device is blameless, so the row stays and no strike is counted
        // against it: a failureCount raised by our own misconfiguration would
        // outlive the fix.
        //
        // Logged at error because this is the failure mode with no other
        // alarm. It retries forever and looks exactly like "push is quiet".
        logger.error('APNs rejected the provider, not the device', {
          component: 'push',
          reason: result.reason,
          status: result.status,
          topic: device.bundleId,
          environment: device.environment,
        });
        return;
      }

      await db.deviceToken.update({
        where: { id: device.id },
        data: { failureCount: { increment: 1 } },
      });
    }),
  );

  if (deadDevices.length > 0) {
    await db.deviceToken.deleteMany({ where: { id: { in: deadDevices } } });
  }

  return delivered;
}

/**
 * Register (or refresh) a device.
 *
 * Keyed on the ENDPOINT, not on the user. The same browser re-subscribing after
 * its keys rotate must UPDATE its row — a second row for one device means every
 * notification is delivered to it twice.
 */
export async function subscribeDevice(
  db: PrismaClient,
  input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  },
): Promise<{ id: string }> {
  // guardrail-allow: cross-tenant — a notification and a push subscription belong
  // to a PERSON, not to a club. They are protected per-USER by the owner-only RLS
  // policy on app.user_id (same shape as wearables, P20); a tenant filter would
  // be the wrong boundary entirely, since everyone at a club shares a tenant.
  const sub = await db.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      // A device that was handed to somebody else, or a shared computer. The
      // endpoint now belongs to whoever just subscribed — otherwise their
      // notifications would go on being delivered to the previous user's row.
      userId: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      failureCount: 0,
    },
  });

  return { id: sub.id };
}

export async function unsubscribeDevice(
  db: PrismaClient,
  input: { endpoint: string },
): Promise<void> {
  // guardrail-allow: cross-tenant — a notification and a push subscription belong
  // to a PERSON, not to a club. They are protected per-USER by the owner-only RLS
  // policy on app.user_id (same shape as wearables, P20); a tenant filter would
  // be the wrong boundary entirely, since everyone at a club shares a tenant.
  await db.pushSubscription.deleteMany({ where: { endpoint: input.endpoint } });
}

/** The notification centre's list. Unread first is NOT what we do — see below. */
export async function listNotifications(
  db: PrismaClient,
  input: { userId: string; limit?: number; unreadOnly?: boolean },
) {
  // guardrail-allow: cross-tenant — a notification and a push subscription belong
  // to a PERSON, not to a club. They are protected per-USER by the owner-only RLS
  // policy on app.user_id (same shape as wearables, P20); a tenant filter would
  // be the wrong boundary entirely, since everyone at a club shares a tenant.
  return db.notification.findMany({
    where: {
      userId: input.userId,
      ...(input.unreadOnly ? { readAt: null } : {}),
    },
    // Newest first, regardless of read state. Sorting unread to the top makes
    // the list JUMP the moment something is marked read, and the thing the user
    // was about to tap moves out from under their finger.
    orderBy: { createdAt: 'desc' },
    take: Math.min(input.limit ?? 30, 100),
  });
}

export async function unreadCount(db: PrismaClient, userId: string): Promise<number> {
  // guardrail-allow: cross-tenant — a notification and a push subscription belong
  // to a PERSON, not to a club. They are protected per-USER by the owner-only RLS
  // policy on app.user_id (same shape as wearables, P20); a tenant filter would
  // be the wrong boundary entirely, since everyone at a club shares a tenant.
  return db.notification.count({ where: { userId, readAt: null } });
}

/**
 * Mark read. Idempotent, and never un-reads.
 *
 * `readAt: null` in the WHERE means a second call is a no-op rather than
 * rewriting the timestamp — which would make "when did I read this?"
 * unanswerable, and would move the item in any list sorted by it.
 */
export async function markRead(
  db: PrismaClient,
  input: { userId: string; notificationIds: string[] },
): Promise<{ marked: number }> {
  // guardrail-allow: cross-tenant — a notification and a push subscription belong
  // to a PERSON, not to a club. They are protected per-USER by the owner-only RLS
  // policy on app.user_id (same shape as wearables, P20); a tenant filter would
  // be the wrong boundary entirely, since everyone at a club shares a tenant.
  const result = await db.notification.updateMany({
    where: {
      userId: input.userId,
      id: { in: input.notificationIds.slice(0, 200) },
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return { marked: result.count };
}

export async function markAllRead(
  db: PrismaClient,
  input: { userId: string },
): Promise<{ marked: number }> {
  // guardrail-allow: cross-tenant — a notification belongs to a PERSON, not a
  // club. Owner-only RLS on app.user_id is the boundary; a tenant filter here
  // would leave a user with unread notifications they could never clear, at
  // whichever club they were not currently looking at.
  const result = await db.notification.updateMany({
    where: { userId: input.userId, readAt: null },
    data: { readAt: new Date() },
  });

  return { marked: result.count };
}

/**
 * Notify somebody once the work being notified about has COMMITTED.
 *
 * ═══ WHY THIS CANNOT GO IN THE CALLER'S TRANSACTION ═══
 *
 * The obvious wiring is to write the notification inside the transaction that
 * confirms the booking, so the two are atomic. It does not work, and the
 * reason is not performance:
 *
 *   `notification` is OWNER-ONLY on `app.user_id` (P22), like
 *   `push_subscription` and `device_token`. A notification belongs to a
 *   PERSON, not to a club.
 *
 * The checkout route holds a TENANT binding — `app.tenant_id` is set,
 * `app.user_id` is not — so the INSERT fails the policy's WITH CHECK and the
 * whole payment transaction dies. Found by exactly that: the wallet-covers-it
 * test started returning 500 INTERNAL.
 *
 * So it is a separate, user-bound piece of work, and it runs AFTER the commit.
 * That ordering is the one this module's header insists on anyway: push only
 * what is already on the record. A crash in between costs the user a banner,
 * not a booking.
 *
 * ═══ NEVER THROWS ═══
 *
 * The caller has already committed money. A push failure — Apple having a bad
 * minute, a dead endpoint — must not turn a completed payment into a 500, and
 * for the Stripe webhook it must not produce a non-2xx for an event we have
 * already claimed, since the retry would be discarded as a duplicate.
 */
/**
 * A notification described by CATALOGUE KEY, not by sentence.
 *
 * The caller cannot write the copy, because the caller does not know what
 * language to write it in — a Stripe webhook has no user, no cookie and no
 * request locale. Only the recipient's own `User.locale` decides that, and it
 * is read here, at the moment of sending.
 */
export interface LocalisedNotifyInput {
  tenantId?: string | null;
  userId: string;
  kind: NotificationKind;
  /**
   * A key under the `notifications` namespace. The catalogue holds `.title`
   * and `.body` beneath it.
   */
  messageKey: string;
  /** ICU values for the body. Money arrives as CENTS and is formatted here. */
  params?: Record<string, string | number>;
  /** Amounts to render in the recipient's locale, keyed by placeholder name. */
  money?: Record<string, { cents: number; currency: string }>;
  href?: string;
  refType?: string;
  refId?: string;
}

/**
 * Notify somebody, in THEIR language, once the work has committed.
 *
 * ═══ WHY THE COPY IS NOT PASSED IN ═══
 *
 * It used to be: `title: 'Booking confirmed'`, written into the call site.
 * That is English for every recipient for ever, on a product that ships in
 * Bulgarian — and it is not reachable by any translator, because it never
 * touches a catalogue.
 *
 * The recipient's `User.locale` is the only thing that can answer this, so it
 * is read here rather than guessed upstream. It defaults to `bg` at the
 * database level, so the answer for a user who has never chosen is Bulgarian.
 *
 * Money is formatted in that same locale: Bulgarian writes "24,00 €", not
 * "€24.00", and a notification is exactly where that is noticed.
 *
 * ═══ NEVER THROWS ═══
 *
 * See below. The caller has already committed money.
 */
export async function notifyAfterCommit(input: LocalisedNotifyInput): Promise<number> {
  try {
    const locale = await runAsSuperuser((db) =>
      db.user
        .findUnique({ where: { id: input.userId }, select: { locale: true } })
        .then((u) => resolveLocale(u?.locale)),
    );

    const values: Record<string, string | number> = { ...input.params };
    for (const [name, amount] of Object.entries(input.money ?? {})) {
      values[name] = formatMoneyFor(locale, amount.cents, amount.currency);
    }

    const key = `notifications.${input.messageKey}`;
    const [title, body] = await Promise.all([
      translateFor(locale, `${key}.title`),
      translateFor(locale, `${key}.body`, values),
    ]);

    const { pushed } = await runAsUserOnly(input.userId, (db) =>
      notify(db, {
        tenantId: input.tenantId,
        userId: input.userId,
        kind: input.kind,
        title,
        body,
        href: input.href,
        refType: input.refType,
        refId: input.refId,
      }),
    );

    return pushed;
  } catch (err) {
    logger.warn('notification failed after commit', {
      component: 'notifications',
      userId: input.userId,
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
