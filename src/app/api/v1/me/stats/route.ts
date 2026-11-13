import { type NextRequest } from 'next/server';

import { myStats } from '@/app-layer/usecases/my-stats';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { toStatsPersonDto, toStatsVenueDto } from '@/app/api/v1/_lib/stats-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/stats?sport=PADEL (#688): the caller's own statistics in one
 * sport, for the phone's «Профил» → «Прогрес»: the level over time, the
 * record and form, sets and games, partners and rivals, activity, the
 * standing at the club they play most at, and milestones. Without `?sport=`,
 * the sport they have played most; `sports` lists every one they declared or
 * played. All from the results already kept (`my-stats.ts`).
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const sport = sportParam(req.nextUrl.searchParams.get('sport')) ?? null;
  const s = await myStats(ctx.userId, sport);
  return ok({
    sports: s.sports,
    sport: s.sport,
    rating: s.rating && {
      ...s.rating,
      series: s.rating.series.map((p) => ({ at: p.at.toISOString(), level: p.level })),
      peak: s.rating.peak && { level: s.rating.peak.level, at: s.rating.peak.at.toISOString() },
    },
    performance: s.performance,
    form: s.form.map((f) => ({ matchId: f.matchId, outcome: f.outcome, at: f.at.toISOString() })),
    sets: s.sets,
    partners: s.partners.map((p) => ({ ...p, person: toStatsPersonDto(p.person) })),
    rivals: s.rivals.map((p) => ({ ...p, person: toStatsPersonDto(p.person) })),
    activity: {
      ...s.activity,
      venues: s.activity.venues.map((v) => ({
        ...toStatsVenueDto(v),
        games: v.games,
        wins: v.wins,
      })),
    },
    standing: s.standing && {
      ...s.standing,
      rows: s.standing.rows.map((r) => ({ ...r, isYou: r.userId === ctx.userId })),
    },
    milestones: s.milestones.map((m) => ({
      kind: m.kind,
      value: m.value,
      at: m.at?.toISOString() ?? null,
      person: m.person && toStatsPersonDto(m.person),
    })),
  });
}

export const GET = defineV1Route(handler);
