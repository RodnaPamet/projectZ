import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * The SMS code that confirms a phone number (#500): who sends it and who
 * checks it.
 *
 *   the four INFOBIP_* settings   → Infobip's 2FA API (owner decision
 *                                   2026-10-13), which makes the code, puts it
 *                                   in the message template, sends it, expires
 *                                   it and counts the wrong guesses itself
 *   else DEPLOY_ENV=test and
 *        PHONE_VERIFY_TEST_CODE   → a stand-in for the test suites: sends
 *                                   nothing, and that one code confirms any
 *                                   number
 *   else                          → none: the phone step answers 503
 *                                   PHONE_VERIFY_UNAVAILABLE, loudly, and
 *                                   nothing is confirmed
 *
 * playerz never sees or stores a code it did not get from the person: Infobip
 * holds it. So there is no code column, nothing to leak, and nothing here
 * that could mark a number confirmed without Infobip saying `verified`.
 *
 * ═══ A CODE IS CHECKED BY ITS ID, NOT BY THE NUMBER ═══
 *
 * Sending answers with a `pinId`, and checking takes that id and the digits.
 * So `start` returns it as `ref` and `check` takes it back. Nothing here ties
 * a `ref` to a person or a number: the use case does, with a signed challenge
 * (src/lib/account/phone-challenge.ts), or a person could have a code sent to
 * their own phone and then claim somebody else's number with it.
 *
 * ═══ THE INFOBIP SIDE (docs/deploy-gcp.md, "The phone check") ═══
 *
 * One 2FA application and one message template per language, made once in the
 * owner's account. The application sets how long a code lives and how many
 * guesses it gets; the template is the text of the SMS, with `{{pin}}`.
 *
 * ═══ WHAT IS LOGGED ═══
 *
 * Never the number, the code or the pin id: the outcome and Infobip's status.
 * A number is personal data, and a code is a credential.
 */

export type StartOutcome =
  /** `ref`: the provider's id for the code it sent; `check` takes it back. */
  | { ok: true; ref: string }
  /** `invalid`: not a number that can get an SMS. `limited`: too many sends to it. */
  | { ok: false; reason: 'invalid' | 'limited' | 'failed' };

export type CheckOutcome =
  | { ok: true }
  /** `wrong`: not the code. `expired`: that code is gone. `limited`: too many guesses. */
  | { ok: false; reason: 'wrong' | 'expired' | 'limited' | 'failed' };

export interface PhoneVerifier {
  readonly name: 'infobip' | 'test';
  /** Send a code to `e164`, in the person's language where there is a template for it. */
  start(e164: string, locale: string): Promise<StartOutcome>;
  /** Is `code` the one sent as `ref`? */
  check(ref: string, code: string): Promise<CheckOutcome>;
}

export interface VerifierConfig {
  INFOBIP_BASE_URL?: string;
  INFOBIP_API_KEY?: string;
  INFOBIP_2FA_APPLICATION_ID?: string;
  /** The message template in Bulgarian, the default. */
  INFOBIP_2FA_MESSAGE_ID?: string;
  /** The message template in English; the Bulgarian one is sent without it. */
  INFOBIP_2FA_MESSAGE_ID_EN?: string;
  DEPLOY_ENV?: string;
  PHONE_VERIFY_TEST_CODE?: string;
}

type InfobipConfig = Required<
  Pick<
    VerifierConfig,
    'INFOBIP_BASE_URL' | 'INFOBIP_API_KEY' | 'INFOBIP_2FA_APPLICATION_ID' | 'INFOBIP_2FA_MESSAGE_ID'
  >
> &
  Pick<VerifierConfig, 'INFOBIP_2FA_MESSAGE_ID_EN'>;

const INFOBIP_TIMEOUT_MS = 8_000;

/** What `POST /2fa/2/pin` answers (Infobip's `TfaStartAuthenticationResponse`). */
interface SendPinResponse {
  pinId?: string;
  /** `MESSAGE_SENT` | `MESSAGE_NOT_SENT` */
  smsStatus?: string;
  /** `NC_DESTINATION_REACHABLE` | `NC_DESTINATION_NOT_REACHABLE` | `NC_DESTINATION_UNKNOWN` | `NC_NOT_CONFIGURED` */
  ncStatus?: string;
}

/** What `POST /2fa/2/pin/{pinId}/verify` answers (`TfaVerifyPinResponse`). */
interface VerifyPinResponse {
  verified?: boolean;
  attemptsRemaining?: number;
  /** `NO_ERROR` | `WRONG_PIN` | `TTL_EXPIRED` | `NO_MORE_PIN_ATTEMPTS` */
  pinError?: string;
}

export function infobipVerifier(
  cfg: InfobipConfig,
  fetchImpl: typeof fetch = fetch,
): PhoneVerifier {
  const base = cfg.INFOBIP_BASE_URL.replace(/\/+$/, '');

  async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `App ${cfg.INFOBIP_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INFOBIP_TIMEOUT_MS),
    });
    let parsed = {} as T;
    try {
      parsed = (await res.json()) as T;
    } catch {
      // Not JSON: the status alone decides.
    }
    return { status: res.status, body: parsed };
  }

  return {
    name: 'infobip',
    async start(e164, locale) {
      const messageId =
        locale === 'en' && cfg.INFOBIP_2FA_MESSAGE_ID_EN
          ? cfg.INFOBIP_2FA_MESSAGE_ID_EN
          : cfg.INFOBIP_2FA_MESSAGE_ID;
      try {
        // `ncNeeded=false`: no number lookup before sending. It is a separate
        // product, and without it configured the SMS would not be sent at all.
        const { status, body } = await post<SendPinResponse>('/2fa/2/pin?ncNeeded=false', {
          applicationId: cfg.INFOBIP_2FA_APPLICATION_ID,
          messageId,
          // Infobip writes numbers as digits, with no plus.
          to: e164.replace(/^\+/, ''),
        });
        if (status >= 200 && status < 300 && body.pinId && body.smsStatus === 'MESSAGE_SENT') {
          return { ok: true, ref: body.pinId };
        }
        const reason =
          status === 429
            ? 'limited'
            : status === 400 || body.ncStatus === 'NC_DESTINATION_NOT_REACHABLE'
              ? 'invalid'
              : 'failed';
        logger.warn('phone verification was not started', {
          component: 'phone-verify',
          status,
          smsStatus: body.smsStatus ?? null,
          ncStatus: body.ncStatus ?? null,
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
    async check(ref, code) {
      try {
        const { status, body } = await post<VerifyPinResponse>(
          `/2fa/2/pin/${encodeURIComponent(ref)}/verify`,
          { pin: code },
        );
        if (status >= 200 && status < 300) {
          if (body.verified === true) return { ok: true };
          if (body.pinError === 'TTL_EXPIRED') return { ok: false, reason: 'expired' };
          if (body.pinError === 'NO_MORE_PIN_ATTEMPTS') return { ok: false, reason: 'limited' };
          return { ok: false, reason: 'wrong' };
        }
        // 404: no such pin any more. 429: the application's verify limit.
        const reason = status === 404 ? 'expired' : status === 429 ? 'limited' : 'failed';
        if (reason === 'failed') {
          logger.warn('phone verification check failed', { component: 'phone-verify', status });
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
      return { ok: true, ref: 'test-pin' };
    },
    async check(_ref, given) {
      return given === code ? { ok: true } : { ok: false, reason: 'wrong' };
    },
  };
}

/** The verifier this configuration gives, or null when there is none. */
export function verifierFor(cfg: VerifierConfig): PhoneVerifier | null {
  const {
    INFOBIP_BASE_URL: base,
    INFOBIP_API_KEY: key,
    INFOBIP_2FA_APPLICATION_ID: app,
    INFOBIP_2FA_MESSAGE_ID: message,
  } = cfg;
  if (base && key && app && message) {
    return infobipVerifier({
      INFOBIP_BASE_URL: base,
      INFOBIP_API_KEY: key,
      INFOBIP_2FA_APPLICATION_ID: app,
      INFOBIP_2FA_MESSAGE_ID: message,
      INFOBIP_2FA_MESSAGE_ID_EN: cfg.INFOBIP_2FA_MESSAGE_ID_EN,
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
    INFOBIP_BASE_URL: env.INFOBIP_BASE_URL,
    INFOBIP_API_KEY: env.INFOBIP_API_KEY,
    INFOBIP_2FA_APPLICATION_ID: env.INFOBIP_2FA_APPLICATION_ID,
    INFOBIP_2FA_MESSAGE_ID: env.INFOBIP_2FA_MESSAGE_ID,
    INFOBIP_2FA_MESSAGE_ID_EN: env.INFOBIP_2FA_MESSAGE_ID_EN,
    DEPLOY_ENV: env.DEPLOY_ENV,
    PHONE_VERIFY_TEST_CODE: env.PHONE_VERIFY_TEST_CODE,
  });
}

/** Is the rule on: a confirmed number before booking, joining a game or writing (#500)? */
export function phoneRequired(): boolean {
  return env.REQUIRE_PHONE === '1';
}
