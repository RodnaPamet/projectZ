import { FUNNEL_STEPS, type UsageEventName } from './events';

/**
 * The funnel's arithmetic (#371), pure, so the platform page's client island
 * and the server agree on it without either importing the other's world.
 */

export type FunnelCounts = Record<UsageEventName, number>;

export function emptyCounts(): FunnelCounts {
  return {
    VENUES_VIEW: 0,
    VENUE_VIEW: 0,
    SLOTS_VIEW: 0,
    SLOT_PICKED: 0,
    SHEET_OPENED: 0,
    BOOKING_CREATED: 0,
  };
}

export interface FunnelStep {
  event: UsageEventName;
  count: number;
  /** This step over the step before it, 0–1; null for the first step or after a zero. */
  fromPrevious: number | null;
}

/**
 * Each step's count and its conversion from the step before. A venue's own
 * funnel starts at its page (`VENUE_VIEW`): the `/venues` index is about no
 * single venue.
 */
export function funnelSteps(
  counts: FunnelCounts,
  steps: readonly UsageEventName[] = FUNNEL_STEPS,
): FunnelStep[] {
  return steps.map((event, i) => {
    const prev = i === 0 ? null : counts[steps[i - 1]!];
    return {
      event,
      count: counts[event],
      fromPrevious: prev === null || prev === 0 ? null : counts[event] / prev,
    };
  });
}

export type Trend = 'up' | 'down' | 'flat';

/** A change of half a percentage point or less is no change. */
const TREND_EPSILON = 0.005;

/** An online share against the period before, or null when either had no bookings. */
export function trendOf(
  now: number | null | undefined,
  before: number | null | undefined,
): Trend | null {
  if (now == null || before == null) return null;
  if (now - before > TREND_EPSILON) return 'up';
  if (before - now > TREND_EPSILON) return 'down';
  return 'flat';
}
