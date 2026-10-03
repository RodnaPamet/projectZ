import { NextRequest } from 'next/server';

import { POST as enrolRoute } from '@/app/api/v1/me/mfa/enrolment/route';
import { POST as confirmRoute } from '@/app/api/v1/me/mfa/enrolment/confirm/route';
import { POST as stepUpRoute } from '@/app/api/v1/me/mfa/step-up/route';
import { totpAt, totpStep } from '@/lib/auth/totp';

/**
 * Drive the second factor through the REAL routes (#262), the way a moderator
 * does: start enrolment, read the secret, type the authenticator's code.
 *
 * Deliberately not a database shortcut. A test that set `mfaVerifiedAt` by hand
 * would pass even if enrolment or the step-up were broken, and "the moderation
 * queue still works end to end with step-up" is exactly the claim these
 * helpers exist to make true.
 */

type Json = Record<string, unknown>;

function post(url: string, bearer: string, body?: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function callEnrol(bearer: string) {
  const res = await enrolRoute(post('http://t/api/v1/me/mfa/enrolment', bearer), {});
  return { status: res.status, json: (await res.json()) as Json };
}

export async function callConfirm(bearer: string, code: string) {
  const res = await confirmRoute(
    post('http://t/api/v1/me/mfa/enrolment/confirm', bearer, { code }),
    {},
  );
  return { status: res.status, json: (await res.json()) as Json };
}

export async function callStepUp(bearer: string, body: unknown) {
  const res = await stepUpRoute(post('http://t/api/v1/me/mfa/step-up', bearer, body), {});
  return { status: res.status, json: (await res.json()) as Json };
}

/**
 * A code for a step strictly AFTER the one just used — the verifier refuses a
 * replayed step, so two proofs inside one 30-second step need the next code
 * (still inside the ±1 window).
 */
export function nextCode(secret: string, afterMs = Date.now()) {
  return totpAt(secret, (totpStep(afterMs) + 1) * 30_000);
}

/**
 * Enrol `bearer`'s account and confirm it, which also steps that session up.
 * Returns the secret (to mint later codes) and the recovery codes.
 */
export async function enrolAndStepUp(bearer: string) {
  const started = await callEnrol(bearer);
  if (started.status !== 200) {
    throw new Error(`enrolment refused: ${started.status} ${JSON.stringify(started.json)}`);
  }
  const { secret } = started.json.data as { secret: string; otpauthUri: string };
  const confirmed = await callConfirm(bearer, totpAt(secret, Date.now()));
  if (confirmed.status !== 200) {
    throw new Error(`confirmation refused: ${confirmed.status} ${JSON.stringify(confirmed.json)}`);
  }
  const { recoveryCodes } = confirmed.json.data as { recoveryCodes: string[] };
  return { secret, recoveryCodes };
}
