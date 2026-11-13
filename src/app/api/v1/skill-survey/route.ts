import { type NextRequest } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { SURVEY_SPORTS, surveyFor } from '@/lib/ratings/skill-survey';

/**
 * GET /api/v1/skill-survey?sport=PADEL (#689): «Вземи начално ниво», the
 * questions and their answers in Bulgarian and English. The level each answer
 * suggests stays on the server, which scores `POST /me/skill-survey`. `sports`
 * lists the sports that have one; 404 for a sport that has none.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const sport = sportParam(req.nextUrl.searchParams.get('sport'));
  if (!sport) throw new ValidationError('sport is required', { field: 'sport' });
  const questions = surveyFor(sport);
  if (!questions) throw new NotFoundError('No questionnaire for this sport');
  return ok({
    sports: SURVEY_SPORTS,
    sport,
    questions: questions.map((q) => ({
      id: q.id,
      text: q.text,
      options: q.options.map((o) => ({ id: o.id, text: o.text })),
    })),
  });
}

export const GET = defineV1Route(handler);
