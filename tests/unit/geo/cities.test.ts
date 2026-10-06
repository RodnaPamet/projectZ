import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

import {
  canonicalCity,
  citiesMatching,
  CITY_SPELLINGS,
  cityKey,
  cityLabel,
  citySpellings,
  type CityKey,
} from '@/lib/geo/cities';

/**
 * Bulgarian city names (#357, audit A07): the table that turns a venue's
 * stored `Sofia` into "София" on a Bulgarian page, and lets "соф" find it.
 */
describe('the city table', () => {
  const keys = Object.keys(CITY_SPELLINGS) as CityKey[];

  it('every city has a name in both catalogues, Cyrillic in Bulgarian', () => {
    for (const k of keys) {
      expect((bg.cities as Record<string, string>)[k]).toMatch(/[А-Яа-я]/);
      expect((en.cities as Record<string, string>)[k]).toMatch(/^[A-Za-z ]+$/);
    }
    // And nothing in the catalogue that the table cannot reach.
    expect(Object.keys(bg.cities).sort()).toEqual([...keys].sort());
    expect(Object.keys(en.cities).sort()).toEqual([...keys].sort());
  });

  it('no spelling names two cities', () => {
    const all = Object.values(CITY_SPELLINGS).flatMap((s) => s.map((n) => n.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
  });

  it('the canonical spelling is Latin, so ?city= stays what the API always took', () => {
    for (const k of keys) expect(CITY_SPELLINGS[k][0]).toMatch(/^[A-Za-z ]+$/);
  });
});

describe('cityKey / cityLabel', () => {
  const t = (k: CityKey) => (bg.cities as Record<string, string>)[k]!;

  it.each([
    ['Sofia', 'София'],
    ['sofia', 'София'],
    [' SOFIA ', 'София'],
    ['София', 'София'],
    ['Veliko Turnovo', 'Велико Търново'],
  ])('%j is %s', (raw, name) => {
    expect(cityLabel(t, raw)).toBe(name);
  });

  it('a city not in the table renders exactly as stored', () => {
    expect(cityKey('Кранево')).toBeNull();
    expect(cityLabel(t, 'Кранево')).toBe('Кранево');
  });
});

describe('matching', () => {
  it('?city= finds every spelling of a known city, and only itself for an unknown one', () => {
    expect(citySpellings('София')).toEqual(['Sofia', 'София']);
    expect(citySpellings('Кранево')).toEqual(['Кранево']);
  });

  it('a search names a city by any part of any spelling', () => {
    expect(citiesMatching('соф')).toEqual(['Sofia', 'София']);
    expect(citiesMatching('PLOV')).toEqual(['Plovdiv', 'Пловдив']);
  });

  it('a one-letter or unknown search names no city', () => {
    expect(citiesMatching('с')).toEqual([]);
    expect(citiesMatching('padel arena')).toEqual([]);
  });

  it('canonicalCity collapses spellings to the one ?city= carries', () => {
    expect(canonicalCity('софия')).toBe('Sofia');
    expect(canonicalCity(' Кранево ')).toBe('Кранево');
  });
});
