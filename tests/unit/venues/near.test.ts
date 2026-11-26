import { KEYS } from '@/lib/data/keys';
import {
  clampRadiusKm,
  DEFAULT_RADIUS_KM,
  mapPins,
  nearParams,
  pinBounds,
  roundCoord,
} from '@/lib/venues/near';

/** «Близо до мен»'s reach and the clubs map's pins on /venues (#697). */
describe('the slider’s reach', () => {
  it('is a whole number of km inside 1–100, as the phone and the server', () => {
    expect(clampRadiusKm(25)).toBe(25);
    expect(clampRadiusKm(0)).toBe(1);
    expect(clampRadiusKm(-5)).toBe(1);
    expect(clampRadiusKm(100)).toBe(100);
    expect(clampRadiusKm(250)).toBe(100);
    expect(clampRadiusKm(42.6)).toBe(43);
  });

  it('reads what storage kept, and the default for anything else', () => {
    expect(clampRadiusKm('60')).toBe(60);
    expect(clampRadiusKm(null)).toBe(DEFAULT_RADIUS_KM);
    expect(clampRadiusKm('')).toBe(DEFAULT_RADIUS_KM);
    expect(clampRadiusKm('far')).toBe(DEFAULT_RADIUS_KM);
    expect(clampRadiusKm(NaN)).toBe(DEFAULT_RADIUS_KM);
    expect(DEFAULT_RADIUS_KM).toBe(25);
  });
});

describe('the near read', () => {
  it('is keyed on the point to ~100 m, the reach and the list’s filters', () => {
    const p = nearParams({ lat: 42.697712, lng: 23.321868 }, 60, { sport: 'PADEL', city: 'sofia' });
    expect(p).toEqual({
      lat: 42.698,
      lng: 23.322,
      radiusKm: 60,
      q: undefined,
      city: 'sofia',
      sport: 'PADEL',
    });
    expect(KEYS.venuesNear(p)).toBe(
      '/api/v1/venues/near?city=sofia&lat=42.698&lng=23.322&radiusKm=60&sport=PADEL',
    );
  });

  it('a few metres of drift is the same key, so no new read', () => {
    const a = KEYS.venuesNear(nearParams({ lat: 42.69771, lng: 23.32187 }, 25, {}));
    const b = KEYS.venuesNear(nearParams({ lat: 42.69774, lng: 23.32184 }, 25, {}));
    expect(a).toBe(b);
    expect(roundCoord(-0.0004)).toBe(-0);
  });

  it('a reach past the slider is sent as the slider’s end', () => {
    expect(nearParams({ lat: 42, lng: 23 }, 500, {}).radiusKm).toBe(100);
  });
});

describe('the map’s pins', () => {
  const v = (id: string, lat: number, lng: number, fromPriceCents: number | null = 2000) => ({
    id,
    name: id,
    lat,
    lng,
    fromPriceCents,
  });

  it('keeps bookable venues with a real coordinate', () => {
    const pins = mapPins([
      v('sofia', 42.69, 23.32),
      v('no-price', 42.1, 24.7, null),
      v('nowhere', 0, 0),
      v('nan', NaN, 23),
      v('off-earth', 95, 23),
      v('varna', 43.2, 27.9),
    ]);
    expect(pins.map((p) => p.id)).toEqual(['sofia', 'varna']);
  });

  it('frames the pins, and has no frame without them', () => {
    expect(pinBounds([v('sofia', 42.69, 23.32), v('varna', 43.2, 27.9)])).toEqual([
      [23.32, 42.69],
      [27.9, 43.2],
    ]);
    expect(pinBounds([])).toBeNull();
  });

  it('the map read carries the list’s filters', () => {
    expect(KEYS.venuesMap({ sport: 'TENNIS', city: 'plovdiv' })).toBe(
      '/api/v1/venues/map?city=plovdiv&sport=TENNIS',
    );
    expect(KEYS.venuesMap()).toBe('/api/v1/venues/map');
  });
});
