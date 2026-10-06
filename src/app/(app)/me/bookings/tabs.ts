/**
 * The Предстоящи and Минали tabs of /me/bookings (#359), as
 * `GET /api/v1/me/bookings?when=` names them.
 *
 * No directive: the page reads the tab on the server and the toggle on the
 * client, and a `'use client'` module's functions cannot be called from the
 * server (tests/guardrails/client-boundary.test.ts).
 */
export type BookingTab = 'upcoming' | 'past';

export const BOOKING_TABS: readonly BookingTab[] = ['upcoming', 'past'];

/** `?tab=past` opens Минали; anything else, or nothing, opens Предстоящи. */
export function bookingTabFrom(raw: string | string[] | undefined): BookingTab {
  return raw === 'past' ? 'past' : 'upcoming';
}
