import { type NextRequest } from 'next/server';

import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { requestLocale } from '@/app/api/v1/_lib/locale';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { ValidationError } from '@/lib/errors/types';
import { nextStoryMidnight, SportStoryNotFoundError, storyFor } from '@/lib/sports/stories';

/**
 * GET /api/v1/sports/{sport}/story?locale= (owner 2026-11-13): a sport's
 * short history and its fact of the day, for the sport pages.
 *
 *   { sport, history: [p1, p2], fact: { text, number, date } }
 *
 * `number` is 1–52 and `date` the Sofia day it is the fact of: it changes at
 * midnight in Sofia (src/lib/sports/stories.ts). The language is the
 * request's (`requestLocale`). Public: a story is the same for everyone and
 * says nothing about anyone. It touches no database: the stories are files.
 *
 * 400 BAD_REQUEST for a sport this server does not know; 404 STORY_NOT_FOUND
 * for one whose story has not been written yet.
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
  const story = storyFor(sport, await requestLocale(req), now);
  if (!story) throw new SportStoryNotFoundError(sport);

  const maxAge = Math.max(0, Math.floor((nextStoryMidnight(now).getTime() - now.getTime()) / 1000));
  return ok(story, {
    headers: {
      'cache-control': `public, max-age=${maxAge}`,
      vary: 'Cookie, Authorization',
    },
  });
}

export const GET = defineV1Route(handler);
