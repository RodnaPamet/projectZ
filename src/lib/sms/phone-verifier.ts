import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * The SMS code that confirms a phone number (#500): who sends it and who
 * checks it.
 *
 *   the three TWILIO_* settings   → Twilio Verify, which sends the code, keeps
 *                                   it, expires it (10 minutes) and counts the
 *                                   wrong guesses itself
 *   else DEPLOY_ENV=test and
 *        PHONE_VERIFY_TEST_CODE   → a stand-in for the test suites: sends
 *                                   nothing, and that one code confirms any
 *                                   number
 *   else                          → none: the phone step answers 503
 *                                   PHONE_VERIFY_UNAVAILABLE, loudly, and
 *                                   nothing is confirmed
 *
 * playerz never sees or stores a code it did not get from the person: Twilio
 * holds it. So there is no code column, nothing to leak, and nothing here
 * that could mark a number confirmed without Twilio saying `approved`.
 *
 * ═══ WHAT IS LOGGED ═══
 *
 * Never the number and never the code: the outcome, Twilio's error code and
 * its status. A number is personal data, and a code is a credential.
 */

export type StartOutcome =
  | { ok: true }
  /** `invalid`: not a number that can get an SMS. `limited`: too many sends to it. */
  | { ok: false; reason: 'invalid' | 'limited' | 'failed' };

export type CheckOutcome =
  | { ok: true }
  /** `wrong`: not the code. `expired`: no live code for this number. `limited`: too many guesses. */
  | { ok: false; reason: 'wrong' | 'expired' | 'limited' | 'failed' };

export interface PhoneVerifier {
  readonly name: 'twilio' | 'test';
  /** Send a code to `e164`, in the person's language where Twilio has it. */
  start(e164: string, locale: string): Promise<StartOutcome>;
  /** Is `code` the one sent to `e164`? */
  check(e164: string, code: string): Promise<CheckOutcome>;
}

export interface VerifierConfig {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  DEPLOY_ENV?: string;
  PHONE_VERIFY_TEST_CODE?: string;
}

const TWILIO_TIMEOUT_MS = 8_000;

/**
 * Twilio's error codes this cares about (https://www.twilio.com/docs/api/errors):
 * 60200 invalid parameter (a number that is not one), 60205 SMS not supported
 * by a landline, 21211/21614 not a valid or mobile number, 60203 max send
 * attempts, 60202 max check attempts, 20404 no pending verification.
 */
const INVALID_NUMBER = new Set([60200, 60205, 21211, 21614, 60033]);
const SEND_LIMIT = new Set([60203, 60212]);
const CHECK_LIMIT = new Set([60202]);

export function twilioVerifier(
  cfg: Required<
    Pick<VerifierConfig, 'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_VERIFY_SERVICE_SID'>
  >,
  fetchImpl: typeof fetch = fetch,
): PhoneVerifier {
  const base = `https://verify.twilio.com/v2/Services/${cfg.TWILIO_VERIFY_SERVICE_SID}`;
  const auth = `Basic ${Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}`;

  async function post(
    path: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: { status?: string; code?: number } }> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    let body: { status?: string; code?: number } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Not JSON: the status alone decides.
    }
    return { status: res.status, body };
  }

  return {
    name: 'twilio',
    async start(e164, locale) {
      try {
        const { status, body } = await post('/Verifications', {
          To: e164,
          Channel: 'sms',
          Locale: locale === 'en' ? 'en' : 'bg',
        });
        if (status >= 200 && status < 300) return { ok: true };
        const reason =
          body.code !== undefined && INVALID_NUMBER.has(body.code)
            ? 'invalid'
            : status === 429 || (body.code !== undefined && SEND_LIMIT.has(body.code))
              ? 'limited'
              : 'failed';
        logger.warn('phone verification was not started', {
          component: 'phone-verify',
          status,
          twilioCode: body.code ?? null,
          reason,
        });
        return { ok: false, reason };
      } catch (err) {
        logger.error('phone verification start failed', {
          component: 'phone-verify',
          error: err instanceof Error ? err.name : 'unknown',
        });
        return { ok: false, reason: 'failed' };
      }
    },
    async check(e164, code) {
      try {
        const { status, body } = await post('/VerificationCheck', { To: e164, Code: code });
        if (status >= 200 && status < 300) {
          return body.status === 'approved' ? { ok: true } : { ok: false, reason: 'wrong' };
        }
        // 404: the code expired, was used, or was never sent to this number.
        const reason =
          status === 404
            ? 'expired'
            : status === 429 || (body.code !== undefined && CHECK_LIMIT.has(body.code))
              ? 'limited'
              : 'failed';
        if (reason === 'failed') {
          logger.warn('phone verification check failed', {
            component: 'phone-verify',
            status,
            twilioCode: body.code ?? null,
          });
        }
        return { ok: false, reason };
      } catch (err) {
        logger.error('phone verification check failed', {
          component: 'phone-verify',
          error: err instanceof Error ? err.name : 'unknown',
        });
        return { ok: false, reason: 'failed' };
      }
    },
  };
}

/** The test suites' verifier: no SMS, one code. Never built outside DEPLOY_ENV=test. */
export function testVerifier(code: string): PhoneVerifier {
  return {
    name: 'test',
    async start() {
      return { ok: true };
    },
    async check(_e164, given) {
      return given === code ? { ok: true } : { ok: false, reason: 'wrong' };
    },
  };
}

/** The verifier this configuration gives, or null when there is none. */
export function verifierFor(cfg: VerifierConfig): PhoneVerifier | null {
  const {
    TWILIO_ACCOUNT_SID: sid,
    TWILIO_AUTH_TOKEN: token,
    TWILIO_VERIFY_SERVICE_SID: service,
  } = cfg;
  if (sid && token && service) {
    return twilioVerifier({
      TWILIO_ACCOUNT_SID: sid,
      TWILIO_AUTH_TOKEN: token,
      TWILIO_VERIFY_SERVICE_SID: service,
    });
  }
  if (cfg.DEPLOY_ENV === 'test' && cfg.PHONE_VERIFY_TEST_CODE) {
    return testVerifier(cfg.PHONE_VERIFY_TEST_CODE);
  }
  return null;
}

/** The process's verifier, from the environment. Null: the phone step is unavailable. */
export function phoneVerifier(): PhoneVerifier | null {
  return verifierFor({
    TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
    TWILIO_VERIFY_SERVICE_SID: env.TWILIO_VERIFY_SERVICE_SID,
    DEPLOY_ENV: env.DEPLOY_ENV,
    PHONE_VERIFY_TEST_CODE: env.PHONE_VERIFY_TEST_CODE,
  });
}

/** Is the rule on: a confirmed number before booking, joining a game or writing (#500)? */
export function phoneRequired(): boolean {
  return env.REQUIRE_PHONE === '1';
}
