import type { MyMatch, StatsPerson, StatsVenue } from '@/app-layer/usecases/my-stats';
import { cityNames } from '@/app/api/v1/_lib/city-names';
import type { CityKey } from '@/lib/geo/cities';

/** A partner, rival or opponent: no name for a blocked or deleted one. */
export const toStatsPersonDto = (p: StatsPerson) => ({
  userId: p.userId,
  name: p.name,
  avatarUrl: p.avatarUrl,
});

/** A venue, with its city in both languages (#667). */
export const toStatsVenueDto = (v: StatsVenue) => ({
  id: v.id,
  name: v.name,
  city: v.city,
  cityKey: v.cityKey,
  cityNames: cityNames(v.city, (v.cityKey as CityKey | null) ?? undefined),
});

/** One counted match, from the caller's side. */
export const toMyMatchDto = (m: MyMatch) => ({
  matchId: m.matchId,
  playedAt: m.playedAt.toISOString(),
  outcome: m.outcome,
  venue: m.venue ? toStatsVenueDto(m.venue) : null,
  partners: m.partners.map(toStatsPersonDto),
  opponents: m.opponents.map(toStatsPersonDto),
  score: m.score,
  levelBefore: m.levelBefore,
  levelAfter: m.levelAfter,
  tournament: m.tournament,
});
