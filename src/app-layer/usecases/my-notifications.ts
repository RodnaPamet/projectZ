import type { NotificationKind } from '@prisma/client';

import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * The caller's own bell (#367): `GET /api/v1/me/notifications`,
 * `POST /api/v1/me/notifications/read`, and the email settings behind
 * `GET`/`PATCH /api/v1/me/notification-settings`.
 *
 * ═══ OWN ROWS ONLY, TWICE ═══
 *
 * Every query runs in `runAsUserOnly(userId)`, where `notification` is
 * owner-only under RLS (P22), AND names `userId` in its WHERE. The user id is
 * the session's; nothing in a request can point it at another account. An id
 * that is not the caller's is indistinguishable from one that does not exist.
 */

export const NOTIFICATIONS_PAGE_DEFAULT = 20;
export const NOTIFICATIONS_PAGE_MAX = 50;
export const MARK_READ_MAX = 100;

export interface MyNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href: string | null;
  refType: string | null;
  refId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export class NotificationCursorError extends Error {
  constructor() {
    super('That cursor names no notification of yours.');
    this.name = 'NotificationCursorError';
  }
}

export class NotificationNotFoundError extends Error {
  constructor() {
    super('No such notification.');
    this.name = 'NotificationNotFoundError';
  }
}

export function clampNotificationLimit(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return NOTIFICATIONS_PAGE_DEFAULT;
  return Math.max(1, Math.min(Math.trunc(requested), NOTIFICATIONS_PAGE_MAX));
}

/**
 * Newest first, keyset-paged on `(createdAt, id)`. The cursor is the last
 * item's id; one that names no row of the caller's is refused rather than
 * answered with an empty page, which would read as "that is everything".
 */
export async function listMyNotifications(input: {
  userId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<{ items: MyNotification[]; nextCursor: string | null; unreadCount: number }> {
  const take = clampNotificationLimit(input.limit);
  return runAsUserOnly(input.userId, async (db) => {
    let after: { createdAt: Date; id: string } | null = null;
    if (input.cursor) {
      after = await db.notification.findFirst({
        where: { id: input.cursor, userId: input.userId },
        select: { createdAt: true, id: true },
      });
      if (!after) throw new NotificationCursorError();
    }

    const [rows, unreadCount] = await Promise.all([
      // guardrail-allow: cross-tenant — a notification belongs to a PERSON, not a
      // club: owner-only RLS on app.user_id is the boundary, and userId is the session's.
      db.notification.findMany({
        where: {
          userId: input.userId,
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          href: true,
          refType: true,
          refId: true,
          readAt: true,
          createdAt: true,
        },
      }),
      // guardrail-allow: cross-tenant — a notification belongs to a PERSON, not a
      // club: owner-only RLS on app.user_id is the boundary, and userId is the session's.
      db.notification.count({ where: { userId: input.userId, readAt: null } }),
    ]);

    const items = rows.slice(0, take);
    return {
      items,
      nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null,
      unreadCount,
    };
  });
}

/**
 * Mark the caller's notifications read: the ids given, or all of them.
 * Idempotent and never un-reads. An id that is not the caller's (someone
 * else's, or none at all) refuses the whole call with not-found, and marks
 * nothing.
 */
export async function markMyNotificationsRead(input: {
  userId: string;
  ids?: string[];
  all?: boolean;
  now?: Date;
}): Promise<{ marked: number; unreadCount: number }> {
  const now = input.now ?? new Date();
  return runAsUserOnly(input.userId, async (db) => {
    // A notification belongs to a PERSON, not a club: owner-only RLS on
    // app.user_id is the boundary, and userId is the session's.
    let marked = 0;
    if (input.all) {
      marked = // guardrail-allow: cross-tenant — owner-only, see above
        (
          await db.notification.updateMany({
            where: { userId: input.userId, readAt: null },
            data: { readAt: now },
          })
        ).count;
    } else {
      const ids = [...new Set(input.ids ?? [])].slice(0, MARK_READ_MAX);
      // guardrail-allow: cross-tenant — owner-only, see above
      const own = await db.notification.count({ where: { userId: input.userId, id: { in: ids } } });
      if (own !== ids.length) throw new NotificationNotFoundError();
      marked = // guardrail-allow: cross-tenant — owner-only, see above
        (
          await db.notification.updateMany({
            where: { userId: input.userId, id: { in: ids }, readAt: null },
            data: { readAt: now },
          })
        ).count;
    }
    // guardrail-allow: cross-tenant — owner-only, see above
    const unreadCount = await db.notification.count({
      where: { userId: input.userId, readAt: null },
    });
    return { marked, unreadCount };
  });
}

// ─── Email settings (Q22) ───────────────────────────────────────────────

export interface NotificationSettings {
  /** The bell is always on; these switch the emails only. */
  email: { confirmation: boolean; reminder: boolean; clubChanges: boolean; messages: boolean };
}

const SETTINGS_SELECT = {
  emailBookingConfirmations: true,
  emailBookingReminders: true,
  emailClubChanges: true,
  emailMessages: true,
} as const;

function toSettings(u: {
  emailBookingConfirmations: boolean;
  emailBookingReminders: boolean;
  emailClubChanges: boolean;
  emailMessages: boolean;
}): NotificationSettings {
  return {
    email: {
      confirmation: u.emailBookingConfirmations,
      reminder: u.emailBookingReminders,
      clubChanges: u.emailClubChanges,
      messages: u.emailMessages,
    },
  };
}

/** Null when the account row is gone; the route answers that as signed out. */
export async function getMyNotificationSettings(
  userId: string,
): Promise<NotificationSettings | null> {
  // `app_user` carries no row security (P04); the WHERE is the session's id.
  const u = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({ where: { id: userId }, select: SETTINGS_SELECT }),
  );
  return u ? toSettings(u) : null;
}

export async function updateMyNotificationSettings(
  userId: string,
  patch: Partial<NotificationSettings['email']>,
): Promise<NotificationSettings | null> {
  const data = {
    ...(patch.confirmation !== undefined ? { emailBookingConfirmations: patch.confirmation } : {}),
    ...(patch.reminder !== undefined ? { emailBookingReminders: patch.reminder } : {}),
    ...(patch.clubChanges !== undefined ? { emailClubChanges: patch.clubChanges } : {}),
    ...(patch.messages !== undefined ? { emailMessages: patch.messages } : {}),
  };
  const u = await runAsUserOnly(userId, (db) =>
    db.user.update({ where: { id: userId }, data, select: SETTINGS_SELECT }).catch(() => null),
  );
  return u ? toSettings(u) : null;
}
