import type { SportType } from '@prisma/client';

import type { SportCapability, SportConfig, SportFamily } from './types';

/**
 * THE SPORT REGISTRY — one source of truth.
 *
 * The alternative is `if (sport === 'CHESS')` scattered through use cases,
 * repositories and components. That looks harmless with three sports and is
 * unmaintainable with eighteen: adding a nineteenth means finding every
 * branch, and the one you miss does not fail — it just silently treats the
 * new sport like tennis.
 *
 * So sport-specific behaviour is DATA, and a ratchet
 * (`no-sport-conditionals`) fails the build on a `sport === "…"` literal in
 * components or routes.
 *
 * The registry is keyed by the PRISMA ENUM, and `SPORTS` is typed as
 * `Record<SportType, SportConfig>` — so adding a sport to the schema without
 * a config here is a COMPILE ERROR, not a runtime surprise.
 */
export const SPORTS: Record<SportType, SportConfig> = {
  // ── Racket ────────────────────────────────────────────────────────
  TENNIS: {
    key: 'TENNIS',
    family: 'RACKET',
    label: { bg: 'Тенис', en: 'Tennis' },
    icon: 'Circle',
    resourceType: 'COURT',
    teamSize: { min: 2, max: 4, perSide: 2 },
    scoring: 'SETS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'BOTH',
  },
  PADEL: {
    key: 'PADEL',
    family: 'RACKET',
    label: { bg: 'Падел', en: 'Padel' },
    icon: 'Circle',
    resourceType: 'COURT',
    teamSize: { min: 4, max: 4, perSide: 2 },
    scoring: 'SETS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 90,
    indoorOutdoor: 'BOTH',
  },
  BADMINTON: {
    key: 'BADMINTON',
    family: 'RACKET',
    label: { bg: 'Бадминтон', en: 'Badminton' },
    icon: 'Circle',
    resourceType: 'COURT',
    teamSize: { min: 2, max: 4, perSide: 2 },
    scoring: 'POINTS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'INDOOR',
  },
  TABLE_TENNIS: {
    key: 'TABLE_TENNIS',
    family: 'RACKET',
    label: { bg: 'Тенис на маса', en: 'Table tennis' },
    icon: 'Circle',
    resourceType: 'TABLE',
    teamSize: { min: 2, max: 4, perSide: 2 },
    scoring: 'POINTS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 45,
    indoorOutdoor: 'INDOOR',
  },
  BEACH_TENNIS: {
    key: 'BEACH_TENNIS',
    family: 'RACKET',
    label: { bg: 'Плажен тенис', en: 'Beach tennis' },
    icon: 'Circle',
    resourceType: 'COURT',
    teamSize: { min: 2, max: 4, perSide: 2 },
    scoring: 'SETS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'OUTDOOR',
  },
  PICKLEBALL: {
    key: 'PICKLEBALL',
    family: 'RACKET',
    label: { bg: 'Пикълбол', en: 'Pickleball' },
    icon: 'Circle',
    resourceType: 'COURT',
    teamSize: { min: 2, max: 4, perSide: 2 },
    scoring: 'POINTS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'BOTH',
  },
  SQUASH: {
    key: 'SQUASH',
    family: 'RACKET',
    label: { bg: 'Скуош', en: 'Squash' },
    // Neither icon set has a racket; the ball, as for the other racket sports.
    icon: 'Circle',
    resourceType: 'COURT',
    // Singles. Doubles squash needs a wider court than any pilot club has.
    teamSize: { min: 2, max: 2, perSide: 1 },
    // Games to 11, best of five: points, as badminton and table tennis.
    scoring: 'POINTS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 45,
    indoorOutdoor: 'INDOOR',
  },

  // ── Team ball ─────────────────────────────────────────────────────
  FOOTBALL: {
    key: 'FOOTBALL',
    family: 'TEAM_BALL',
    label: { bg: 'Футбол', en: 'Football' },
    icon: 'Goal',
    resourceType: 'FIELD',
    teamSize: { min: 10, max: 22, perSide: 11 },
    scoring: 'GOALS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 90,
    indoorOutdoor: 'OUTDOOR',
  },
  FOOTBALL5: {
    key: 'FOOTBALL5',
    family: 'TEAM_BALL',
    label: { bg: 'Футбол 5х5', en: 'Football 5-a-side' },
    icon: 'Goal',
    resourceType: 'FIELD',
    teamSize: { min: 6, max: 12, perSide: 5 },
    scoring: 'GOALS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'BOTH',
  },
  BASKETBALL: {
    key: 'BASKETBALL',
    family: 'TEAM_BALL',
    label: { bg: 'Баскетбол', en: 'Basketball' },
    // Was 'Dribbble', which lucide-react 1.x dropped with its brand icons:
    // the name pointed at nothing, and nothing noticed until the registry
    // test started checking that every icon exists.
    icon: 'Circle',
    resourceType: 'COURT',
    teamSize: { min: 6, max: 10, perSide: 5 },
    scoring: 'POINTS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'BOTH',
  },
  VOLLEYBALL: {
    key: 'VOLLEYBALL',
    family: 'TEAM_BALL',
    label: { bg: 'Волейбол', en: 'Volleyball' },
    icon: 'Volleyball',
    resourceType: 'COURT',
    teamSize: { min: 8, max: 12, perSide: 6 },
    scoring: 'SETS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 90,
    indoorOutdoor: 'BOTH',
  },
  BEACH_VOLLEYBALL: {
    key: 'BEACH_VOLLEYBALL',
    family: 'TEAM_BALL',
    label: { bg: 'Плажен волейбол', en: 'Beach volleyball' },
    icon: 'Volleyball',
    resourceType: 'COURT',
    teamSize: { min: 4, max: 4, perSide: 2 },
    scoring: 'SETS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'OUTDOOR',
  },
  HANDBALL: {
    key: 'HANDBALL',
    family: 'TEAM_BALL',
    label: { bg: 'Хандбал', en: 'Handball' },
    icon: 'Goal',
    resourceType: 'FIELD',
    teamSize: { min: 10, max: 14, perSide: 7 },
    scoring: 'GOALS',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'INDOOR',
  },

  // ── Board ─────────────────────────────────────────────────────────
  CHESS: {
    key: 'CHESS',
    family: 'BOARD',
    label: { bg: 'Шах', en: 'Chess' },
    icon: 'Crown',
    resourceType: 'BOARD_TABLE',
    teamSize: { min: 2, max: 2, perSide: 1 },
    scoring: 'CHESS',
    // The ONE sport that keeps Glicko-2. It is genuinely 1v1, and Glicko-2 is
    // the established standard there — it is what Lichess uses. An openskill
    // rating for chess would be incomparable to every rating a player already
    // has.
    ratingEngine: 'GLICKO2',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'INDOOR',
  },

  // ── Esport ────────────────────────────────────────────────────────
  ESPORTS: {
    key: 'ESPORTS',
    family: 'ESPORT',
    label: { bg: 'Е-спорт', en: 'E-sports' },
    icon: 'Gamepad2',
    resourceType: 'LOBBY',
    teamSize: { min: 2, max: 10, perSide: 5 },
    scoring: 'CUSTOM',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    selfDeclaredLevel: true,
    defaultDurationMinutes: 120,
    indoorOutdoor: 'INDOOR',
  },

  // ── Motorsport ────────────────────────────────────────────────────
  //
  // Booked as EXCLUSIVE HIRE OF THE WHOLE TRACK, in steps, like a court (owner,
  // 2026-10-07): the booking holds the track, and the EXCLUDE constraint keeps
  // a second group off it. Laps and arrive-and-drive sessions are the club's
  // own sales and never touch playerz. So nothing here is per driver.
  KARTING: {
    key: 'KARTING',
    family: 'MOTORSPORT',
    label: { bg: 'Картинг', en: 'Karting' },
    // The vendored nucleo set (upstream's icons) has no car or chequered flag;
    // its speed gauge is the closest thing it does have.
    icon: 'Gauge6',
    // A TRACK is exclusive: karting is always on one, and nothing else is.
    resourceType: 'TRACK',
    // Whoever hired the track: one driver, or a group up to the track's own
    // capacity (Sofia Karting Ring: 10). No sides.
    teamSize: { min: 1, max: 10 },
    // Lap timing is the club's own system. playerz keeps no score, so no
    // live score either (`supportsCapability('liveScore')`).
    scoring: 'CUSTOM',
    ratingEngine: 'OPENSKILL',
    bookable: true,
    // No 1–7 level on the profile: playerz neither ranks karting (it has no lap
    // times) nor matches drivers (the whole track is hired by one group), so a
    // level would seed nothing; and the seven level sentences describe playing
    // a game against an opponent, not driving.
    selfDeclaredLevel: false,
    defaultDurationMinutes: 15,
    indoorOutdoor: 'BOTH',
  },

  // ── Endurance ─────────────────────────────────────────────────────
  //
  // NOT bookable. You do not reserve a 10km route for an hour — you agree to
  // meet at a point at a time. Modelling these as bookable would force a fake
  // Resource row for every single run, and an EXCLUDE constraint would then
  // stop two groups running the same route at once, which is absurd.
  RUNNING: {
    key: 'RUNNING',
    family: 'ENDURANCE',
    label: { bg: 'Бягане', en: 'Running' },
    icon: 'Footprints',
    resourceType: 'ROUTE',
    teamSize: { min: 1, max: 100 },
    scoring: 'TIME_DISTANCE',
    ratingEngine: 'OPENSKILL',
    bookable: false,
    // The profile's sports are the ones a player books here (#359).
    selfDeclaredLevel: false,
    defaultDurationMinutes: 60,
    indoorOutdoor: 'OUTDOOR',
  },
  CYCLING: {
    key: 'CYCLING',
    family: 'ENDURANCE',
    label: { bg: 'Колоездене', en: 'Cycling' },
    icon: 'Bike',
    resourceType: 'ROUTE',
    teamSize: { min: 1, max: 100 },
    scoring: 'TIME_DISTANCE',
    ratingEngine: 'OPENSKILL',
    bookable: false,
    selfDeclaredLevel: false,
    defaultDurationMinutes: 120,
    indoorOutdoor: 'OUTDOOR',
  },
};

export class UnsupportedCapabilityError extends Error {
  constructor(sport: SportType, capability: SportCapability) {
    super(
      `${sport} does not support "${capability}". ` +
        `Check the registry (src/lib/sports/registry.ts) before assuming a capability.`,
    );
    this.name = 'UnsupportedCapabilityError';
  }
}

export function getSportConfig(key: SportType): SportConfig {
  return SPORTS[key];
}

/**
 * Is `value` a value of the Sport enum? For a `?sport=` read off a URL anyone
 * can write (#334): an unknown value must stop here, not reach Prisma as an
 * invalid enum and come back as a 500. Own keys only, so `toString` or
 * `__proto__` are not sports.
 */
export function isSportKey(value: unknown): value is SportType {
  return typeof value === 'string' && Object.hasOwn(SPORTS, value);
}

export function allSports(): SportConfig[] {
  return Object.values(SPORTS);
}

export function sportsByFamily(family: SportFamily): SportConfig[] {
  return allSports().filter((s) => s.family === family);
}

export function bookableSports(): SportConfig[] {
  return allSports().filter((s) => s.bookable);
}

export function supportsCapability(key: SportType, capability: SportCapability): boolean {
  const c = SPORTS[key];

  switch (capability) {
    case 'slotBooking':
      return c.bookable;
    case 'teams':
      return c.teamSize.perSide !== undefined && c.teamSize.perSide > 1;
    case 'meetingPoint':
      // Endurance sports meet at a lat/lng, not at a reserved resource.
      return c.family === 'ENDURANCE';
    case 'liveScore':
      return c.scoring !== 'CUSTOM';
  }
}

/**
 * Assert BEFORE relying on a capability.
 *
 * `assertSportSupports('RUNNING', 'slotBooking')` throws — which is the whole
 * point. Without it, a booking flow that quietly accepts RUNNING creates a
 * slot reservation for a route, and nobody finds out until a runner is told
 * the trail is "already booked".
 */
export function assertSportSupports(key: SportType, capability: SportCapability): void {
  if (!supportsCapability(key, capability)) {
    throw new UnsupportedCapabilityError(key, capability);
  }
}
