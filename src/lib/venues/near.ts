/**
 * «Близо до мен» and the clubs map on /venues (#697), as the phone has them
 * (owner 2026-11-13: "full match with the phone"). Plain functions, no
 * directive: the list calls them, and the unit tests pin them.
 */

/** The slider's reach, as the phone's: 1–100 km, the server's own cap. */
export const RADIUS_MIN_KM = 1;
export const RADIUS_MAX_KM = 100;
/** Where the slider starts before anyone moves it, as on the phone. */
export const DEFAULT_RADIUS_KM = 25;
/** Where the browser keeps the last reach: a convenience, never the truth. */
export const RADIUS_STORAGE_KEY = 'venues.radiusKm';

/** A whole number of km inside 1–100; anything unreadable is the default. */
export function clampRadiusKm(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_RADIUS_KM;
  return Math.min(RADIUS_MAX_KM, Math.max(RADIUS_MIN_KM, Math.round(n)));
}

/**
 * A coordinate to three decimals, about 100 m. Enough for a 1 km reach, and
 * the read's key stays the same while the person stands still: a browser's
 * fix moves by a few metres between two reads, which would be a new key and
 * a new request each time.
 */
export function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** What the near read is asked: the point, the reach, and the list's filters. */
export function nearParams(
  here: { lat: number; lng: number },
  radiusKm: number,
  filters: { q?: string; city?: string; sport?: string },
) {
  return {
    lat: roundCoord(here.lat),
    lng: roundCoord(here.lng),
    radiusKm: clampRadiusKm(radiusKm),
    q: filters.q,
    city: filters.city,
    sport: filters.sport,
  };
}

/** The whole country, before any pin is known: the phone's region. */
export const BULGARIA_VIEW = { longitude: 25.3, latitude: 42.75, zoom: 5.6 } as const;

/** A venue as the map needs it. */
export interface MapPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * The venues that can stand on the map: a real coordinate (not missing, not
 * the 0,0 a venue saved without one would carry), and a price, which is what
 * bookable means (`GET /venues/map` keeps only those; the near and favourite
 * lists do not filter, so this does for them).
 */
export function mapPins<T extends MapPin & { fromPriceCents: number | null }>(venues: T[]): T[] {
  return venues.filter(
    (v) =>
      v.fromPriceCents !== null &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lng) &&
      Math.abs(v.lat) <= 90 &&
      Math.abs(v.lng) <= 180 &&
      !(v.lat === 0 && v.lng === 0),
  );
}

/** The box around the pins, `[[west, south], [east, north]]`; null with none. */
export function pinBounds(pins: readonly MapPin[]): [[number, number], [number, number]] | null {
  if (pins.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of pins) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}
