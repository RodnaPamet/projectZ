import { type NextRequest } from 'next/server';

import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { requestLocale } from '@/app/api/v1/_lib/locale';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { ValidationError } from '@/lib/errors/types';
import { factOfTheWeek, nextFactWeekStart, SportFactsNotFoundError } from '@/lib/sports/facts';

/**
 * GET /api/v1/sports/{sport}/fact?locale= (owner 2026-11-13): a sport's fun
 * fact of the week, for the sport pages.
 *
 *   { sport, fact: { text, number, weekStart } }
 *
 * `number` is 1–52 and `weekStart` the Sofia Monday of the week it is the
 * fact of: it changes at Monday 00:00 in Sofia (src/lib/sports/facts.ts). The
 * language is the request's (`requestLocale`). Public: a fact is the same for
 * everyone and says nothing about anyone. It touches no database: the facts
 * are files.
 *
 * 400 BAD_REQUEST for a sport this server does not know; 404 FACT_NOT_FOUND
 * for one whose facts have not been written yet.
 *
 * Cached until the fact changes. `Vary`, because without `?locale=` the
 * language comes from the cookie or the token, and a shared cache must not
 * hand one person's Bulgarian to another's English.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ sport: string }> }) {
  const { sport: raw } = await params;
  const sport = sportParam(raw);
  if (!sport) throw new ValidationError('sport is required', { field: 'sport' });
  const now = new Date();
  const fact = factOfTheWeek(sport, await requestLocale(req), now);
  if (!fact) throw new SportFactsNotFoundError(sport);

  const maxAge = Math.max(0, Math.floor((nextFactWeekStart(now).getTime() - now.getTime()) / 1000));
  return ok(fact, {
    headers: {
      'cache-control': `public, max-age=${maxAge}`,
      vary: 'Cookie, Authorization',
    },
  });
}

export const GET = defineV1Route(handler);
