import { getToken } from 'next-auth/jwt';
import { type NextRequest, NextResponse } from 'next/server';

import { completeGoogleCalendarConnect } from '@/app-layer/usecases/google-calendar';
import { withApiErrorHandling } from '@/lib/errors/api';

/**
 * GET /api/integrations/google-calendar/callback — where Google sends a person
 * back after the calendar consent (owner 2026-11-14). Ported from agri-saas's
 * `/api/integrations/google/callback`.
 *
 * ALWAYS A REDIRECT, never a JSON body: the phone reads this URL's final
 * redirect out of an ASWebAuthenticationSession, and a 4xx with a body would
 * look exactly like the person closing the sheet.
 *
 *   phone  bg.playerz.app://integrations/google-calendar?result=connected
 *          bg.playerz.app://integrations/google-calendar?error=<code>
 *   web    /me/profile?googleCalendar=connected | <code>
 *
 * `<code>` is one of CONNECT_ERROR_CODES (the use case), a closed set.
 *
 * Public at the edge (guard.ts) and on purpose: the phone's sheet carries no
 * session. The single-use `state` is the credential; on the web the session
 * the request does carry must also be the person who started the consent.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const params = req.nextUrl.searchParams;
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET }).catch(() => null);
  const to = await completeGoogleCalendarConnect({
    state: params.get('state'),
    code: params.get('code'),
    error: params.get('error'),
    sessionUserId: typeof token?.sub === 'string' ? token.sub : null,
  });
  const res = NextResponse.redirect(to, 303);
  res.headers.set('cache-control', 'no-store');
  return res;
});
