import type { NotificationKind } from '@prisma/client';

import { runAsUserOnly } from '@/lib/db/rls-middleware';
import {
  CATEGORY_OF,
  kindsInCategory,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '@/lib/notifications/category';

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
  /** One group only (#668); the cursor pages within it. */
  category?: NotificationCategory;
}): Promise<{
  items: MyNotification[];
  nextCursor: string | null;
  unreadCount: number;
  /** Unread per group (#668), every group present; they add up to `unreadCount`. */
  unreadByCategory: Record<NotificationCategory, number>;
}> {
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
          ...(input.category ? { kind: { in: kindsInCategory(input.category) } } : {}),
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
    // guardrail-allow: cross-tenant — as above: the session's own unread rows, by kind.
    const unreadKinds = await db.notification.groupBy({
      by: ['kind'],
      where: { userId: input.userId, readAt: null },
      _count: { _all: true },
    });
    const unreadByCategory = Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((c) => [c, 0]),
    ) as Record<NotificationCategory, number>;
    for (const k of unreadKinds) unreadByCategory[CATEGORY_OF[k.kind]] += k._count._all;

    const items = rows.slice(0, take);
    return {
      items,
      nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null,
      unreadCount,
      unreadByCategory,
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

/** The kinds a person switches, for email and for the phone alike. */
export interface NotificationKinds {
  confirmation: boolean;
  reminder: boolean;
  clubChanges: boolean;
  messages: boolean;
  /** «Игри» (#376): requests to one's game, and answers to one's requests. */
  openPlay: boolean;
  /**
   * «Уроци, които водя» (#550, owner decision 22): a coach's notifications
   * about the lessons they teach. Every account has the setting; only a coach
   * is shown it, and only a coach is ever sent one.
   */
  lessonsTaught: boolean;
}

/** The phone's switches: every email kind, and the ones that only push. */
export interface PushKinds extends NotificationKinds {
  /**
   * «Факт на деня» (P88): the daily fun fact about the player's main sport.
   * Push only, so the email switches have no such kind.
   */
  sportFacts: boolean;
}

export interface NotificationSettings {
  /** The bell is always on; these switch the emails only. */
  email: NotificationKinds;
  /**
   * The same kinds on the phone (#529, P77): whether an event also pushes to
   * the person's registered devices, and the push-only `sportFacts`.
   */
  push: PushKinds;
  /**
   * How many phones this account has registered for push. At 0 the push
   * switches decide nothing yet, and a screen may leave them out.
   */
  pushDevices: number;
}

const SETTINGS_SELECT = {
  emailBookingConfirmations: true,
  emailBookingReminders: true,
  emailClubChanges: true,
  emailMessages: true,
  emailOpenPlay: true,
  emailLessonsTaught: true,
  pushBookingConfirmations: true,
  pushBookingReminders: true,
  pushClubChanges: true,
  pushMessages: true,
  pushOpenPlay: true,
  pushLessonsTaught: true,
  pushSportFacts: true,
} as const;

type SettingsRow = { -readonly [K in keyof typeof SETTINGS_SELECT]: boolean };

/** Each kind's column, per channel. One table, read by both directions. */
const COLUMN: Record<'email' | 'push', Record<keyof NotificationKinds, keyof SettingsRow>> = {
  email: {
    confirmation: 'emailBookingConfirmations',
    reminder: 'emailBookingReminders',
    clubChanges: 'emailClubChanges',
    messages: 'emailMessages',
    openPlay: 'emailOpenPlay',
    lessonsTaught: 'emailLessonsTaught',
  },
  push: {
    confirmation: 'pushBookingConfirmations',
    reminder: 'pushBookingReminders',
    clubChanges: 'pushClubChanges',
    messages: 'pushMessages',
    openPlay: 'pushOpenPlay',
    lessonsTaught: 'pushLessonsTaught',
  },
};

const KINDS = Object.keys(COLUMN.email) as Array<keyof NotificationKinds>;

/** The kinds that only ring the phone, and their columns. */
const PUSH_ONLY: Record<Exclude<keyof PushKinds, keyof NotificationKinds>, keyof SettingsRow> = {
  sportFacts: 'pushSportFacts',
};

function kindsOf(u: SettingsRow, channel: 'email' | 'push'): NotificationKinds {
  return Object.fromEntries(
    KINDS.map((k) => [k, u[COLUMN[channel][k]]]),
  ) as unknown as NotificationKinds;
}

function toSettings(u: SettingsRow, pushDevices: number): NotificationSettings {
  return {
    email: kindsOf(u, 'email'),
    push: { ...kindsOf(u, 'push'), sportFacts: u[PUSH_ONLY.sportFacts] },
    pushDevices,
  };
}

/** Null when the account row is gone; the route answers that as signed out. */
export async function getMyNotificationSettings(
  userId: string,
): Promise<NotificationSettings | null> {
  // `app_user` carries no row security (P04); the WHERE is the session's id.
  // `device_token` is the person's own (owner-only under RLS).
  return runAsUserOnly(userId, async (db) => {
    const u = await db.user.findUnique({ where: { id: userId }, select: SETTINGS_SELECT });
    if (!u) return null;
    return toSettings(u, await db.deviceToken.count({ where: { userId } }));
  });
}

export async function updateMyNotificationSettings(
  userId: string,
  patch: {
    email?: Partial<NotificationKinds>;
    push?: Partial<PushKinds>;
  },
): Promise<NotificationSettings | null> {
  const data: Partial<SettingsRow> = {};
  for (const channel of ['email', 'push'] as const) {
    for (const k of KINDS) {
      const value = patch[channel]?.[k];
      if (value !== undefined) data[COLUMN[channel][k]] = value;
    }
  }
  for (const [k, column] of Object.entries(PUSH_ONLY) as Array<
    [keyof typeof PUSH_ONLY, keyof SettingsRow]
  >) {
    const value = patch.push?.[k];
    if (value !== undefined) data[column] = value;
  }
  return runAsUserOnly(userId, async (db) => {
    const u = await db.user
      .update({ where: { id: userId }, data, select: SETTINGS_SELECT })
      .catch(() => null);
    if (!u) return null;
    return toSettings(u, await db.deviceToken.count({ where: { userId } }));
  });
}

/** The caller's unread count alone (#668), for `GET /me/summary`. */
export async function countMyUnread(userId: string): Promise<number> {
  return runAsUserOnly(userId, (db) =>
    // guardrail-allow: cross-tenant — a notification belongs to a PERSON, not a
    // club: owner-only RLS on app.user_id is the boundary, and userId is the session's.
    db.notification.count({ where: { userId, readAt: null } }),
  );
}
