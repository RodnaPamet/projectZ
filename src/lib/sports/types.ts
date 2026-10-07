import type { ResourceType, SportType } from '@prisma/client';

export type SportFamily = 'RACKET' | 'TEAM_BALL' | 'BOARD' | 'ESPORT' | 'MOTORSPORT' | 'ENDURANCE';

export type Scoring = 'SETS' | 'GOALS' | 'POINTS' | 'CHESS' | 'TIME_DISTANCE' | 'CUSTOM';

/**
 * Which rating engine a sport uses.
 *
 * openskill (Weng-Lin) has NATIVE TEAM SUPPORT, which is what padel,
 * volleyball and football actually need — a 2v2 padel result is one
 * observation about four players, not four independent 1v1s. Glicko-2 has no
 * team model, so faking it means inventing a "team rating" that belongs to
 * nobody.
 *
 * Chess is the exception: it is genuinely 1v1, and Glicko-2 is the
 * established standard there (it is literally what Lichess uses). Using
 * openskill for chess would produce ratings nobody could compare to anything.
 */
export type RatingEngine = 'OPENSKILL' | 'GLICKO2';

/** Capabilities a caller can assert a sport supports before relying on one. */
export type SportCapability = 'slotBooking' | 'teams' | 'meetingPoint' | 'liveScore';

export interface SportConfig {
  key: SportType;
  family: SportFamily;
  label: { bg: string; en: string };
  /**
   * The icon's export name: one of the vendored nucleo icons upstream ships
   * (`src/components/ui/icons/nucleo`) where one fits the sport, otherwise a
   * lucide-react icon. Nothing renders it yet; `tests/unit/sports/registry.test.ts`
   * checks that each name exists in one of the two sets, in that order.
   */
  icon: string;
  /**
   * What a booking of this sport holds. A court sport's court may also be
   * stored as another non-exclusive type (a 5-a-side pitch as a FIELD); an
   * EXCLUSIVE type is this sport's alone, both ways (`src/lib/sports/resources.ts`).
   */
  resourceType: ResourceType;
  teamSize: { min: number; max: number; perSide?: number };
  scoring: Scoring;
  ratingEngine: RatingEngine;
  /**
   * Running and cycling are SESSION-based, not slot-bookable. You do not
   * reserve a 10km route for an hour — you agree to meet at a point at a
   * time. Modelling them as bookable would force a fake Resource row for
   * every run.
   */
  bookable: boolean;
  /**
   * Whether a player declares a 1–7 level in it on their profile (#359, Q37).
   * The level is where rankings (#378) and matchmaking start a player from; a
   * sport playerz neither ranks nor matches players in has nothing for one to
   * seed, and the seven sentences describing the levels would not fit it.
   */
  selfDeclaredLevel: boolean;
  defaultDurationMinutes: number;
  indoorOutdoor: 'INDOOR' | 'OUTDOOR' | 'BOTH';
}
