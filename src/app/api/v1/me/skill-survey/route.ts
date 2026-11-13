import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { submitSkillSurvey } from '@/app-layer/usecases/skill-survey';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

const ID = z.string().min(1).max(40);
const bodySchema = z
  .object({
    sport: z.string().min(1).max(40),
    answers: z.record(ID, ID).refine((a) => Object.keys(a).length <= 30, 'Too many answers'),
  })
  .strict();

/**
 * POST /api/v1/me/skill-survey (#689): the caller's answers to «Вземи
 * начално ниво», one option id per question id. The server scores them and
 * sets the declared level the rating starts from; the answer is that level.
 * 400 unless every question has one known answer; 409 `RATING_STARTED` once a
 * counted match has moved the rating; 403 for a club account.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, bodySchema, 'questionnaire answers');
  const sport = sportParam(body.sport)!;
  const level = await submitSkillSurvey(ctx.userId, sport, body.answers);
  return ok({ sport, level });
}

export const POST = defineV1Route(handler);
