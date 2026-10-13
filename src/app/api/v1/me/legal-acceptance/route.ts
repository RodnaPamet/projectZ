import { type NextRequest } from 'next/server';

import { acceptCurrentLegal, legalStanding } from '@/app-layer/usecases/legal-acceptance';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { chosenLocale } from '@/lib/i18n/chosen-locale';
import { getRequestId } from '@/lib/observability/context';

/**
 * The terms and the privacy policy this account has accepted (#462).
 *
 *   GET   the versions in force, the ones accepted, and what is still due
 *   POST  accept every text in force, once; answers the same shape
 *
 * No body: what is accepted is what is in force on the server
 * (content/legal-versions.json), for the signed-in account, in the language
 * the page was shown in. Repeating it changes nothing.
 *
 * 401 UNAUTHORIZED without a session; 429 RATE_LIMITED.
 */
async function signedIn(req: NextRequest): Promise<string> {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ctx.userId;
}

async function get(req: NextRequest) {
  return ok(await legalStanding(await signedIn(req)));
}

async function post(req: NextRequest) {
  const userId = await signedIn(req);
  await acceptCurrentLegal(userId, await chosenLocale());
  return ok(await legalStanding(userId));
}

export const GET = defineV1Route(get);
export const POST = defineV1Route(post);
