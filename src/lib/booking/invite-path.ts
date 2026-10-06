/**
 * Where a booking invite link opens (#358).
 *
 * `/invite/booking/{token}`, beside the staff invite's `/invite/{token}`: the
 * static `booking` segment wins over `[token]`, and a staff token is 43
 * base64url characters, never the word "booking", so neither route can shadow
 * the other.
 *
 * Plain functions with no import, so the API (which answers the absolute URL),
 * the invite page and the client can all spell it once.
 */
export const BOOKING_INVITE_PREFIX = '/invite/booking/';

export function bookingInvitePath(token: string): string {
  return `${BOOKING_INVITE_PREFIX}${encodeURIComponent(token)}`;
}

/** The absolute link to share, on `origin` (the site's own, from the server's config). */
export function bookingInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${bookingInvitePath(token)}`;
}
