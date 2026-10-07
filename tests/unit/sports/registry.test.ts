import * as Lucide from 'lucide-react';

import * as Nucleo from '@/components/ui/icons/nucleo';
import { PROFILE_SPORTS } from '@/lib/profile/limits';
import {
  SPORTS,
  UnsupportedCapabilityError,
  allSports,
  assertSportSupports,
  bookableSports,
  getSportConfig,
  sportsByFamily,
  supportsCapability,
} from '@/lib/sports/registry';
import type { SportFamily } from '@/lib/sports/types';

describe('sport registry', () => {
  it('1. every SportType in the Prisma enum has a config', () => {
    // SPORTS is typed `Record<SportType, SportConfig>`, so a 17th sport added
    // to the schema without a config is a COMPILE error. This asserts the
    // runtime shape agrees, in case somebody reaches for a cast.
    expect(allSports().length).toBeGreaterThanOrEqual(14);
    for (const [key, config] of Object.entries(SPORTS)) {
      expect(config.key).toBe(key);
    }
  });

  it('2. every config has non-empty bg AND en labels', () => {
    // A missing Bulgarian label does not throw — it renders the enum key to a
    // Bulgarian user. Silent, ugly, and only ever noticed by a customer.
    for (const s of allSports()) {
      expect(s.label.bg.trim().length).toBeGreaterThan(0);
      expect(s.label.en.trim().length).toBeGreaterThan(0);
      expect(s.label.bg).not.toBe(s.key);
    }
  });

  it('3. every BOOKABLE sport has a positive default duration', () => {
    for (const s of bookableSports()) {
      expect(s.defaultDurationMinutes).toBeGreaterThan(0);
    }
  });

  it('4. family and resourceType are coherent', () => {
    // ENDURANCE -> ROUTE, BOARD -> BOARD_TABLE, ESPORT -> LOBBY.
    // An incoherent pair means a running route gets an EXCLUDE constraint and
    // two groups cannot run the same trail at once.
    for (const s of allSports()) {
      if (s.family === 'ENDURANCE') expect(s.resourceType).toBe('ROUTE');
      if (s.family === 'BOARD') expect(s.resourceType).toBe('BOARD_TABLE');
      if (s.family === 'ESPORT') expect(s.resourceType).toBe('LOBBY');
    }
  });

  it('5. GLICKO2 is used ONLY for chess', () => {
    // openskill has native TEAM support, which is what padel/volleyball/
    // football actually need — a 2v2 result is one observation about four
    // players, not four 1v1s. Chess is genuinely 1v1, and Glicko-2 is the
    // standard there (it is what Lichess uses).
    const glicko = allSports().filter((s) => s.ratingEngine === 'GLICKO2');
    expect(glicko.map((s) => s.key)).toEqual(['CHESS']);
  });

  it('6. assertSportSupports("RUNNING", "slotBooking") THROWS', () => {
    // The whole point. Without this, a booking flow that quietly accepts
    // RUNNING reserves a slot on a route — and a runner is told the trail is
    // "already booked".
    expect(() => assertSportSupports('RUNNING', 'slotBooking')).toThrow(UnsupportedCapabilityError);
    expect(() => assertSportSupports('CYCLING', 'slotBooking')).toThrow();
    expect(() => assertSportSupports('PADEL', 'slotBooking')).not.toThrow();
  });

  it('7. endurance sports are NOT bookable; everything else is', () => {
    for (const s of allSports()) {
      expect(s.bookable).toBe(s.family !== 'ENDURANCE');
    }
  });

  it('8. sportsByFamily partitions the registry with no gaps or overlaps', () => {
    const families: SportFamily[] = [
      'RACKET',
      'TEAM_BALL',
      'BOARD',
      'ESPORT',
      'MOTORSPORT',
      'ENDURANCE',
    ];
    const seen = families.flatMap((f) => sportsByFamily(f).map((s) => s.key));

    expect(seen.length).toBe(allSports().length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('9. every config names an icon that exists: vendored nucleo first, then lucide-react', () => {
    // A non-empty string was all this checked, and BASKETBALL had named
    // 'Dribbble' since lucide-react 1.x dropped its brand icons. A name that
    // resolves to nothing is the same as no icon, found by whoever first
    // renders one.
    const exists = (name: string) =>
      typeof (Nucleo as Record<string, unknown>)[name] === 'function' ||
      (Lucide as Record<string, unknown>)[name] !== undefined;
    const missing = allSports().filter((s) => !exists(s.icon));
    expect(missing.map((s) => `${s.key}: ${s.icon}`)).toEqual([]);
  });

  it('10. team sports declare a coherent perSide', () => {
    for (const s of allSports()) {
      if (s.teamSize.perSide === undefined) continue;
      // A 5-a-side game needs at least 10 players at max capacity.
      expect(s.teamSize.max).toBeGreaterThanOrEqual(s.teamSize.perSide * 2);
      expect(s.teamSize.min).toBeLessThanOrEqual(s.teamSize.max);
    }
  });

  it('11. the "teams" capability follows perSide', () => {
    expect(supportsCapability('PADEL', 'teams')).toBe(true); // 2 per side
    expect(supportsCapability('CHESS', 'teams')).toBe(false); // 1 per side
  });

  it('12. the "meetingPoint" capability is exactly the endurance sports', () => {
    const meet = allSports().filter((s) => supportsCapability(s.key, 'meetingPoint'));
    expect(meet.map((s) => s.key).sort()).toEqual(['CYCLING', 'RUNNING']);
  });

  it('13. liveScore is unavailable exactly where scoring is CUSTOM', () => {
    expect(supportsCapability('ESPORTS', 'liveScore')).toBe(false);
    expect(supportsCapability('TENNIS', 'liveScore')).toBe(true);
  });

  it('14. getSportConfig round-trips every key', () => {
    for (const s of allSports()) {
      expect(getSportConfig(s.key)).toBe(s);
    }
  });

  it('15. configs are JSON-serialisable (they cross to the client)', () => {
    // A Date, a function or a Symbol in a config would blow up the moment a
    // server component passed it to a client one — and only for the sport
    // that carried it.
    expect(() => JSON.parse(JSON.stringify(SPORTS))).not.toThrow();
    expect(JSON.parse(JSON.stringify(SPORTS.CHESS)).ratingEngine).toBe('GLICKO2');
  });

  it('16. the scoring vocabulary is closed', () => {
    const allowed = ['SETS', 'GOALS', 'POINTS', 'CHESS', 'TIME_DISTANCE', 'CUSTOM'];
    for (const s of allSports()) {
      expect(allowed).toContain(s.scoring);
    }
  });

  it('17. karting is booked on its own TRACK and squash on a COURT (P51)', () => {
    expect(SPORTS.KARTING).toMatchObject({
      family: 'MOTORSPORT',
      resourceType: 'TRACK',
      bookable: true,
      // playerz keeps no lap times, so no score, live or otherwise.
      scoring: 'CUSTOM',
    });
    expect(SPORTS.SQUASH).toMatchObject({
      family: 'RACKET',
      resourceType: 'COURT',
      bookable: true,
    });
    expect(supportsCapability('KARTING', 'slotBooking')).toBe(true);
    expect(supportsCapability('KARTING', 'liveScore')).toBe(false);
    expect(supportsCapability('SQUASH', 'teams')).toBe(false); // singles
  });

  it('18. the profile offers a level in every bookable sport but karting (#359, P51)', () => {
    // The level seeds rankings and matchmaking; playerz does neither for a
    // track hired whole. Kept as data, so `PATCH /me` and the sheet agree.
    expect(PROFILE_SPORTS).toContain('SQUASH');
    expect(PROFILE_SPORTS).not.toContain('KARTING');
    expect([...PROFILE_SPORTS].sort()).toEqual(
      bookableSports()
        .filter((s) => s.key !== 'KARTING')
        .map((s) => s.key)
        .sort(),
    );
  });
});
