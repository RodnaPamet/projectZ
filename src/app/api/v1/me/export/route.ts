import { formatInTimeZone } from 'date-fns-tz';
import { type NextRequest, NextResponse } from 'next/server';

import { exportMyData } from '@/app-layer/usecases/data-export';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { API_VERSION, API_VERSION_HEADER } from '@/lib/api-version';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { DATA_EXPORT_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit, isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';

/**
 * GET /api/v1/me/export — everything playerz holds about me, as a file (#370).
 *
 * The body is the export itself, not the `{ data }` envelope: it is a file the
 * browser saves (`Content-Disposition: attachment`,
 * `playerz-data-YYYY-MM-DD.json`, the date at the platform's home, Sofia), as
 * the statement CSV is. A refusal is still the JSON error envelope, so a client
 * that asked for a file can read why it did not get one.
 *
 * What is in it, and what never is, is `usecases/data-export`'s header. Every
 * account kind may ask; a club account gets its holder's data, not the club's.
 *
 * ═══ RATE-LIMITED HERE, BECAUSE IT IS A GET ═══
 *
 * The v1 wrapper limits mutations only (`defineV1Route`'s header). This read
 * spans every club the person played at, so it carries its own ceiling,
 * DATA_EXPORT_LIMIT (10 an hour per IP and account), checked once the caller
 * is known.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  if (!isRateLimitBypassed()) {
    const { response } = await enforceRateLimit(req, {
      scope: 'data-export',
      config: DATA_EXPORT_LIMIT,
      userId: ctx.userId,
    });
    if (response) {
      response.headers.set(API_VERSION_HEADER, API_VERSION);
      return response;
    }
  }

  const now = new Date();
  const data = await exportMyData(ctx.userId);
  // The account went between the session check and the read: not signed in.
  if (!data) throw new UnauthorizedError('Authentication required');

  const day = formatInTimeZone(now, 'Europe/Sofia', 'yyyy-MM-dd');
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="playerz-data-${day}.json"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      [API_VERSION_HEADER]: API_VERSION,
    },
  });
}

export const GET = defineV1Route(handler);
