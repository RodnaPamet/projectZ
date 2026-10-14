import { type NextRequest, NextResponse } from 'next/server';

import { appleConfirmBodySchema } from '@/app-layer/schemas/apple-email';
import { confirmAppleEmail } from '@/app-layer/usecases/apple-sign-in';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { issueTokens } from '@/app/api/v1/_lib/native-session';
import type { NativeTokens } from '@/app/api/v1/_lib/native-token';
import { checkRateLimit, LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { getClientIp } from '@/lib/security/rate-limit-middleware';

/**
 * POST /api/v1/auth/apple/confirm (#442): the code from the email is right,
 * so the address is the person's. The account is found or made by it, as a
 * Google sign-in's would be, remembers the Apple ID, and the token pair comes
 * back exactly as from `POST /auth/token`. The next Apple sign-in finds the
 * account by its Apple ID and asks nothing.
 *
 * A sign-in, so it draws on the web's `login:<ip>` throttle, like
 * `/auth/token`; and five tries at one Apple ID's code per 10 minutes.
 *
 * 400 EMAIL_CODE_WRONG, EMAIL_CODE_EXPIRED (the challenge is older than 10
 * minutes or not ours: ask for a new code); 429 RATE_LIMITED.
 */
async function handler(req: NextRequest) {
  const ip = getClientIp(req);
  const limit = await checkRateLimit(`login:${ip}`, LOGIN_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } },
      { status: 429, headers: { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }
  const { challenge, code } = await parseJsonBody(req, appleConfirmBodySchema, 'code');
  const { userId } = await confirmAppleEmail(challenge, code);
  return ok<NativeTokens>(await issueTokens(req, userId, ip));
}

export const POST = defineV1Route(handler);
