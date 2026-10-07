/**
 * "Упътване" on the booking detail page (#359): a maps link built from the
 * venue's address, which opens the maps app on a phone and Google Maps in a
 * desktop browser.
 *
 * The ADDRESS, not the coordinates, as the owner asked: it is what the club
 * wrote and what a player recognises, and the destination card in the maps app
 * then shows a street rather than "42.69, 23.32". The coordinates ride along in
 * the API for a native client that wants to hand them to MapKit.
 *
 * Google's documented cross-platform URL (`/maps/dir/?api=1`), so no key and
 * no tracking parameters. No directive: a pure function, unit-tested.
 */
export function directionsUrl(venue: { name: string; addressLine: string; city: string }): string {
  const destination = [venue.name, venue.addressLine, venue.city]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
  const q = new URLSearchParams({ api: '1', destination });
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}
