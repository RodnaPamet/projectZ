import { ResourceType } from '@prisma/client';

import { bookableSports } from '@/lib/sports/registry';
import {
  combineNouns,
  RESOURCE_KINDS,
  RESOURCE_TYPES,
  resourceNoun,
  resourceNouns,
} from '@/lib/sports/resource-kinds';
import {
  allowedResourceTypes,
  defaultResourceType,
  nounForSport,
  resourceTypeAfter,
} from '@/lib/sports/resources';

/**
 * WHAT A RESOURCE IS CALLED, AND WHICH SPORTS MAY USE IT (P51).
 *
 * The noun decides the copy ("корт" or "писта"); the exclusivity decides what
 * the onboarding spec and the courts screen let a club store. Booking never
 * reads either, which tests/integration/squash-karting.test.ts shows end to end.
 */
describe('resource kinds', () => {
  it('cover every ResourceType in the client, in schema order', () => {
    // RESOURCE_KINDS is a Record<ResourceType, …>, so a missing type is a
    // compile error; this pins the runtime list the zod enums derive from.
    expect(RESOURCE_TYPES).toEqual(Object.values(ResourceType));
  });

  it('call a TRACK a track, a FIELD a pitch, and every other type a court', () => {
    expect(resourceNoun('TRACK')).toBe('track');
    expect(resourceNoun('FIELD')).toBe('pitch');
    for (const t of RESOURCE_TYPES.filter((x) => x !== 'TRACK' && x !== 'FIELD')) {
      expect(resourceNoun(t)).toBe('court');
    }
  });

  it('read a type this build does not know as a court, rather than throwing', () => {
    expect(resourceNoun('HOVERCRAFT_LANE')).toBe('court');
    expect(resourceNoun(null)).toBe('court');
    expect(resourceNoun(undefined)).toBe('court');
    expect(resourceNoun('toString')).toBe('court');
  });

  it('name a list by its one noun, by its nouns in order, and courts when empty', () => {
    expect(resourceNouns([])).toBe('court');
    expect(resourceNouns(['COURT', 'TABLE'])).toBe('court');
    expect(resourceNouns(['FIELD', 'FIELD'])).toBe('pitch');
    expect(resourceNouns(['TRACK', 'TRACK'])).toBe('track');
    expect(resourceNouns(['COURT', 'TRACK'])).toBe('courtTrack');
    // Кортове, игрища, писти (#454), whatever order the rows come in.
    expect(resourceNouns(['FIELD', 'COURT'])).toBe('courtPitch');
    expect(resourceNouns(['TRACK', 'FIELD'])).toBe('pitchTrack');
    expect(resourceNouns(['TRACK', 'FIELD', 'LOBBY'])).toBe('courtPitchTrack');
    expect(combineNouns(['track'])).toBe('track');
    expect(combineNouns(['court', 'track', 'court'])).toBe('courtTrack');
  });
});

describe('which types a sport may use', () => {
  it('karting: a TRACK, and only a TRACK', () => {
    expect(allowedResourceTypes('KARTING')).toEqual(['TRACK']);
    expect(defaultResourceType('KARTING')).toBe('TRACK');
    expect(nounForSport('KARTING')).toBe('track');
  });

  it('every other bookable sport: anything but a TRACK, its own type when nobody says', () => {
    for (const s of bookableSports().filter((x) => !RESOURCE_KINDS[x.resourceType].exclusive)) {
      expect(allowedResourceTypes(s.key)).not.toContain('TRACK');
      expect(allowedResourceTypes(s.key)).toContain('COURT');
      // A new resource follows its sport (#472).
      expect(defaultResourceType(s.key)).toBe(s.resourceType);
    }
    expect(allowedResourceTypes('SQUASH')).toEqual(RESOURCE_TYPES.filter((t) => t !== 'TRACK'));
  });

  it.each([
    ['FOOTBALL', 'FIELD', 'pitch'],
    ['FOOTBALL5', 'FIELD', 'pitch'],
    ['HANDBALL', 'FIELD', 'pitch'],
    ['TENNIS', 'COURT', 'court'],
    ['PADEL', 'COURT', 'court'],
    ['SQUASH', 'COURT', 'court'],
    ['KARTING', 'TRACK', 'track'],
  ] as const)('a new %s resource is a %s, and reads as a %s (#472)', (sport, type, noun) => {
    expect(defaultResourceType(sport)).toBe(type);
    expect(nounForSport(sport)).toBe(noun);
  });

  it('an edit moves the type only when the sport no longer allows it', () => {
    expect(resourceTypeAfter('KARTING', 'COURT')).toBe('TRACK');
    expect(resourceTypeAfter('SQUASH', 'TRACK')).toBe('COURT');
    expect(resourceTypeAfter('FOOTBALL5', 'FIELD')).toBe('FIELD');
    expect(resourceTypeAfter('PADEL', 'COURT')).toBe('COURT');
    expect(nounForSport('SQUASH', 'TRACK')).toBe('court');
    expect(nounForSport('KARTING', 'COURT')).toBe('track');
  });
});
