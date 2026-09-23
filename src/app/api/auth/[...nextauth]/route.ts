import NextAuth from 'next-auth';
import { type NextRequest, NextResponse } from 'next/server';

import { authOptions } from '@/auth';
import { checkRateLimit, LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { getClientIp } from '@/lib/security/rate-limit-middleware';

/**
 * The NextAuth catch-all. Until this file existed, nothing in this app could
 * sign in: `authOptions` was configured and imported by zero files, and the
 * e2e `authedPage` fixture POSTed to a 404.
 *
 * ═══ WHAT MOUNTING THIS PUBLISHES ═══
 *
 * Thirteen anonymously-reachable actions, and next-auth 4 offers no way to
 * disable any of them individually: providers, session, csrf, signin, signout,
 * callback, verify-request, error (GET) and signin, signout, callback, _log,
 * session (POST).
 *
 * Most are harmless. `/api/auth/providers` projects each provider down to
 * `{id,name,type,signinUrl,callbackUrl}` and does NOT leak client ids.
 * `/api/auth/session` returns a literal `{}` to an anonymous caller without
 * invoking our session callback. `?callbackUrl=` is checked twice and is not an
 * open redirect.
 *
 * One is not harmless, and it is the reason this file has code in it rather
 * than the usual two lines.
 *
 * ═══ POST /api/auth/callback/credentials IS A BCRYPT ORACLE ═══
 *
 * `authorize()` burns equal bcrypt time on every failure path, which defeats
 * user ENUMERATION. Nothing defeats BRUTE FORCE: without a limiter an attacker
 * may submit passwords as fast as the server will hash them, forever.
 *
 * CSRF is not a control here either — `GET /api/auth/csrf` mints an unlimited
 * supply of valid token pairs to anyone who asks.
 *
 * `LOGIN_LIMIT` has existed since P03 with its threat model written out, and
 * has never had a caller. This is the caller.
 *
 * Keyed on IP alone, deliberately. Keying on the submitted email would mean
 * reading and re-creating the request body before next-auth parses it, and
 * would let an attacker lock a victim out of their own account by spraying
 * their address — turning a defence into a denial of service. IP-only is the
 * coarser, safer choice; per-account penalties belong with
 * `resolveLoginPenalty` and a persisted failure count, not here.
 *
 * The limiter is a process-local Map (rate-limit.ts:17), so the real budget is
 * N x instances. That is worth fixing before this is load-bearing, and it is
 * still enormously better than no limit at all.
 */
const handler = NextAuth(authOptions);

/** Only the credentials POST is throttled. OAuth callbacks carry state we must not drop. */
function isCredentialsSubmission(req: NextRequest): boolean {
  return req.nextUrl.pathname.endsWith('/callback/credentials');
}

export async function POST(req: NextRequest, ctx: unknown) {
  if (isCredentialsSubmission(req)) {
    const result = checkRateLimit(`login:${getClientIp(req)}`, LOGIN_LIMIT);

    if (!result.allowed) {
      // 429 with a generic body. It must NOT say whether the address exists —
      // a throttle that only triggers for real accounts is the enumeration
      // oracle that `dummyVerify` exists to prevent, moved up a layer.
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } },
        {
          status: 429,
          headers: { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) },
        },
      );
    }
  }

  return handler(req, ctx as never);
}

export async function GET(req: NextRequest, ctx: unknown) {
  return handler(req, ctx as never);
}
