import { type NextRequest } from 'next/server';

import { appleEmailBodySchema } from '@/app-layer/schemas/apple-email';
import { sendAppleEmailCode } from '@/app-layer/usecases/apple-sign-in';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';

/**
 * POST /api/v1/auth/apple/email (#442): after a Sign in with Apple that hid
 * the address, send a code to the real one the person typed. Then
 * `POST /auth/apple/confirm` with the code.
 *
 * Takes the `ticket` the `apple` grant of `POST /auth/token` answered with
 * (403 REAL_EMAIL_REQUIRED, `error.details.ticket`) and an address. Answers
 * `{ challenge, expiresInSeconds }`; `challenge` goes back with the code. Says
 * nothing about whether an account has the address: that is settled at
 * confirm, once the code has proved the inbox.
 *
 * 400 APPLE_SIGN_IN_EXPIRED (the ticket is older than 30 minutes, or not
 * ours: sign in with Apple again), EMAIL_INVALID, EMAIL_IS_RELAY; 429
 * RATE_LIMITED (3 codes an hour per Apple ID, and per address); 503
 * EMAIL_UNAVAILABLE when the email could not be sent.
 */
async function handler(req: NextRequest) {
  const { ticket, email } = await parseJsonBody(req, appleEmailBodySchema, 'email step');
  return ok(await sendAppleEmailCode(ticket, email));
}

export const POST = defineV1Route(handler);
