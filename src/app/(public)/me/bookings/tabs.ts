/**
 * The Предстоящи, Минали and Отменени tabs of /me/bookings (#359, #670), as
 * `GET /api/v1/me/bookings?when=` names them.
 *
 * No directive: the page reads the tab on the server and the toggle on the
 * client, and a `'use client'` module's functions cannot be called from the
 * server (tests/guardrails/client-boundary.test.ts).
 */
export type BookingTab = 'upcoming' | 'past' | 'cancelled';

export const BOOKING_TABS: readonly BookingTab[] = ['upcoming', 'past', 'cancelled'];

/** `?tab=past` opens Минали, `?tab=cancelled` Отменени; anything else, or nothing, Предстоящи. */
export function bookingTabFrom(raw: string | string[] | undefined): BookingTab {
  return raw === 'past' || raw === 'cancelled' ? raw : 'upcoming';
}
