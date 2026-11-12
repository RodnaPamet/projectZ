import type { NotificationKind } from '@prisma/client';

/**
 * The bell's groups (#668): what the phone's «Известия» chips filter by. The
 * map is exhaustive over the enum, so a kind added later does not compile
 * until it is given a group, instead of landing silently under «Всички».
 */
export const NOTIFICATION_CATEGORIES = [
  'bookings',
  'games',
  'messages',
  'lessons',
  'tournaments',
  'other',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_OF: Record<NotificationKind, NotificationCategory> = {
  BOOKING_CONFIRMED: 'bookings',
  BOOKING_REMINDER: 'bookings',
  BOOKING_CANCELLED: 'bookings',
  SESSION_FULL: 'bookings',
  PAYMENT_RECEIVED: 'bookings',
  SPLIT_REQUESTED: 'bookings',
  BOOKING_PLAYER_JOINED: 'bookings',
  BOOKING_PLAYER_LEFT: 'bookings',
  BOOKING_PLAYER_ADDED: 'bookings',
  BOOKING_PLAYER_REMOVED: 'bookings',
  MESSAGE_RECEIVED: 'messages',
  CONTACT_REQUEST: 'messages',
  OPEN_PLAY_REQUESTED: 'games',
  OPEN_PLAY_ACCEPTED: 'games',
  OPEN_PLAY_DECLINED: 'games',
  OPEN_PLAY_LAPSED: 'games',
  OPEN_PLAY_CLOSED: 'games',
  MATCH_RESULT: 'games',
  RESULT_REPORTED: 'games',
  RESULT_DISPUTED: 'games',
  RESULT_DECIDED: 'games',
  COACH_PROFILE_SUBMITTED: 'lessons',
  COACH_PROFILE_APPROVED: 'lessons',
  COACH_PROFILE_DECLINED: 'lessons',
  LESSON_BOOKED: 'lessons',
  LESSON_CANCELLED: 'lessons',
  LESSON_REMINDER: 'lessons',
  COACH_LINK_REQUESTED: 'lessons',
  COACH_LINK_ACCEPTED: 'lessons',
  COACH_LINK_DECLINED: 'lessons',
  COACH_LINK_ENDED: 'lessons',
  TOURNAMENT_ROUND: 'tournaments',
  TOURNAMENT_ENTRY_RECEIVED: 'tournaments',
  TOURNAMENT_PARTNER_NAMED: 'tournaments',
  TOURNAMENT_ENTRY_DECIDED: 'tournaments',
  TOURNAMENT_ENTRY_WITHDRAWN: 'tournaments',
  ACHIEVEMENT_UNLOCKED: 'other',
};

/** The kinds of one group, for a `kind IN (…)` filter. */
export function kindsInCategory(category: NotificationCategory): NotificationKind[] {
  return (Object.entries(CATEGORY_OF) as Array<[NotificationKind, NotificationCategory]>)
    .filter(([, c]) => c === category)
    .map(([k]) => k);
}
