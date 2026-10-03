import type { NextRequest } from 'next/server';

import type { RequestContext } from '@/app-layer/types';
import type { MfaCaller } from '@/lib/auth/mfa';
import { UnauthorizedError } from '@/lib/errors/types';
import { getClientIp } from '@/lib/security/rate-limit-middleware';

/**
 * The caller of a `/me/mfa/**` route, as the MFA module needs it: the user,
 * THEIR session (a step-up is bound to it), and where the request came from
 * for the account_security_event row.
 *
 * Throws 401 for an anonymous context. `contextFromRequest` already degraded a
 * revoked or unknown session to anonymous, so a context with a user here has
 * a session id that `checkSession` vouched for.
 */
export function mfaCallerFrom(req: NextRequest, ctx: RequestContext): MfaCaller {
  if (!ctx.userId || !ctx.userSessionId) throw new UnauthorizedError('Authentication required');
  return {
    userId: ctx.userId,
    userSessionId: ctx.userSessionId,
    requestId: ctx.requestId,
    ipAddress: getClientIp(req),
    userAgent: req.headers.get('user-agent'),
  };
}

/** A JSON body field as a string, or undefined — never trusted further than that. */
export function stringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length <= 64 ? v : undefined;
}
