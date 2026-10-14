import { type NextRequest, NextResponse } from 'next/server';

import { appleName, appleSignIn } from '@/app-layer/usecases/apple-sign-in';
import { resolveProviderAccount } from '@/app-layer/usecases/provider-account';
import { ok } from '@/app/api/v1/_lib/envelope';
import { readCappedBody } from '@/app/api/v1/_lib/capped-body';
import { issueTokens } from '@/app/api/v1/_lib/native-session';
import type { NativeTokens } from '@/app/api/v1/_lib/native-token';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { readFacebookEmailPermission } from '@/lib/auth/facebook-permissions';
import {
  NativeGrantError,
  verifyAppleIdToken,
  verifyFacebookAccessToken,
  verifyFacebookIdToken,
  verifyGoogleIdToken,
  type ProviderIdentity,
} from '@/lib/auth/native-grants';
import { passwordSignInEnabled } from '@/lib/auth/password-sign-in';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { isLocale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { checkRateLimit, LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { getClientIp } from '@/lib/security/rate-limit-middleware';

/**
 * POST /api/v1/auth/token — sign in from a native client.
 *
 * ═══ FOUR GRANTS, CHOSEN BY `grant` ═══
 *
 * - `apple`: `{ grant, idToken, nonce?, givenName?, familyName? }`, Sign in
 *   with Apple (#442); a hidden address continues at `/auth/apple/*`.
 * - `google`: `{ grant, idToken }`, the ID token Google's iOS SDK returns.
 * - `facebook`: `{ grant, accessToken }` from classic Facebook Login, or
 *   `{ grant, idToken, nonce? }` from Limited Login (what the SDK returns when
 *   the person declined app tracking).
 * - `password`: `{ email, password }`, with or without `grant`. The TEST
 *   SUITES' grant only (#361): in every deployment it answers 403
 *   `PASSWORD_SIGN_IN_DISABLED`, before the throttle and without a bcrypt.
 *
 * Everyone signs in with Google or Facebook (owner decisions Q15/Q21), and the
 * two provider grants are how the app does it (#444). A provider token is
 * checked against the provider (`@/lib/auth/native-grants`), then the account
 * is resolved by the same function the web's `signIn` callback calls, with
 * the same two refusals before it: no address, or (Google) an address the
 * provider has not proved. A first sign-in creates an undecided account, as
 * on the web (#360).
 *
 * ═══ THE THROTTLE IS THE WEB'S ═══
 *
 * #95 wired LOGIN_LIMIT to POST /api/auth/callback/credentials, keyed
 * `login:<ip>`. This endpoint draws on the SAME key for every grant, so
 * attempts here and on the web share one allowance. A route of its own would
 * be a way around that limiter: the mutation default is 60/min against
 * LOGIN_LIMIT's 10 per 15 minutes. It runs after the body is read (a capped
 * 16 KB, so the grant is known) and before anything costly: a bcrypt, a
 * provider's key set, a Graph call.
 *
 * ═══ WHY THE PASSWORD GRANT DOES NOT CALL authorize() ═══
 *
 * It cannot. next-auth's CredentialsProvider returns an object whose top-level
 * `authorize` is a stub returning null synchronously; the real one is nested
 * under `.options`. The declared type says otherwise, so calling it compiles
 * and rejects every correct password in silence. `verifyCredentials` is the
 * shared implementation both paths use, which also keeps the equal-bcrypt-time
 * enumeration defence in one place.
 */

/** A provider's ID token is about 1-2 KB; nothing legitimate comes close. */
const MAX_BODY_BYTES = 16 * 1024;

type Body = Record<string, unknown> | null;

const fail = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ error: { code, message } }, { status, ...(headers ? { headers } : {}) });

async function readBody(req: NextRequest): Promise<Body> {
  try {
    const raw = await readCappedBody(req, MAX_BODY_BYTES, () => new Error('too large'));
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Unreadable is not a grant. Without `grant` it is the password shape,
    // which answers with the same opaque 401 as a wrong password.
    return null;
  }
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

async function handler(req: NextRequest) {
  const body = await readBody(req);
  const grant = body?.grant ?? 'password';

  if (grant === 'password' && !passwordSignInEnabled()) {
    return fail(
      403,
      'PASSWORD_SIGN_IN_DISABLED',
      'Password sign-in is not available. Sign in with Google or Facebook.',
    );
  }
  if (grant !== 'password' && grant !== 'google' && grant !== 'facebook' && grant !== 'apple') {
    return fail(400, 'UNSUPPORTED_GRANT', 'grant must be google, facebook, apple or password.');
  }

  const ip = getClientIp(req);
  const limit = await checkRateLimit(`login:${ip}`, LOGIN_LIMIT);
  if (!limit.allowed) {
    return fail(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.', {
      'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  }

  let userId: string;
  if (grant === 'password') {
    const user = await verifyCredentials(
      typeof body?.email === 'string' ? body.email : undefined,
      typeof body?.password === 'string' ? body.password : undefined,
    );
    if (!user) {
      // ONE message, and it says nothing about which half was wrong. The
      // timing defence in verifyCredentials is worthless if the response
      // distinguishes "no such account" from "wrong password".
      return fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    userId = user.id;
  } else if (grant === 'apple') {
    const resolved = await appleGrant(body ?? {});
    if (resolved instanceof NextResponse) return resolved;
    userId = resolved;
  } else {
    const resolved = await providerSignIn(grant, body ?? {});
    if (resolved instanceof NextResponse) return resolved;
    userId = resolved;
  }

  return ok<NativeTokens>(await issueTokens(req, userId, ip));
}

/**
 * Sign in with Apple (#442). Apple's identity token, and the name the app was
 * given at the first authorisation (Apple puts no name in the token).
 *
 * An account that remembers this Apple ID, or a real address Apple vouches
 * for, signs in at once. A hidden (relay) address stops here with 403
 * `REAL_EMAIL_REQUIRED` and a ticket: the app asks for a real address, and
 * `POST /auth/apple/email` and `/auth/apple/confirm` finish with a code
 * (owner decision 2026-10-14).
 */
async function appleGrant(body: Record<string, unknown>): Promise<string | NextResponse> {
  const idToken = str(body.idToken, 8192);
  if (!idToken) return fail(400, 'BAD_REQUEST', 'idToken is required.');
  let who: ProviderIdentity;
  try {
    who = await verifyAppleIdToken(idToken, {
      ...(typeof body.nonce === 'string' ? { nonce: body.nonce } : {}),
    });
  } catch (error) {
    if (!(error instanceof NativeGrantError)) throw error;
    logger.warn('native sign-in refused', {
      component: 'auth',
      provider: 'apple',
      code: error.code,
    });
    const status =
      error.code === 'INVALID_PROVIDER_TOKEN'
        ? 401
        : error.code === 'SIGN_IN_METHOD_DISABLED'
          ? 403
          : 503;
    return fail(status, error.code, error.message);
  }
  const outcome = await appleSignIn(
    who,
    appleName(body.givenName, body.familyName),
    isLocale(body.locale) ? body.locale : null,
  );
  if ('userId' in outcome) return outcome.userId;
  return NextResponse.json(
    {
      error: {
        code: 'REAL_EMAIL_REQUIRED',
        message: 'Apple hid the email address. Confirm a real one to continue.',
        details: { ticket: outcome.ticket },
      },
    },
    { status: 403 },
  );
}

/** The account a provider grant signs into, or the response refusing it. */
async function providerSignIn(
  grant: 'google' | 'facebook',
  body: Record<string, unknown>,
): Promise<string | NextResponse> {
  const idToken = str(body.idToken, 8192);
  const accessToken = str(body.accessToken, 4096);
  if (grant === 'google' ? !idToken : !idToken === !accessToken) {
    return fail(
      400,
      'BAD_REQUEST',
      grant === 'google'
        ? 'idToken is required.'
        : 'Send exactly one of accessToken (Facebook Login) or idToken (Limited Login).',
    );
  }

  let who: ProviderIdentity;
  try {
    who =
      grant === 'google'
        ? await verifyGoogleIdToken(idToken!)
        : idToken
          ? await verifyFacebookIdToken(idToken, {
              ...(typeof body.nonce === 'string' ? { nonce: body.nonce } : {}),
            })
          : await verifyFacebookAccessToken(accessToken!);
  } catch (error) {
    if (!(error instanceof NativeGrantError)) throw error;
    logger.warn('native sign-in refused', { component: 'auth', provider: grant, code: error.code });
    const status =
      error.code === 'INVALID_PROVIDER_TOKEN'
        ? 401
        : error.code === 'SIGN_IN_METHOD_DISABLED'
          ? 403
          : 503;
    return fail(status, error.code, error.message);
  }

  // ═══ NO EMAIL, NO ACCOUNT ═══ (the web's rule, `src/auth.ts`)
  //
  // Accounts are found by address, so without one there is nothing to sign
  // into. For a Facebook Login token the person's grant says which of the two
  // causes it was, so the app can offer "allow access to your email" only
  // where asking again can help.
  if (!who.email) {
    const permission =
      grant === 'facebook' && accessToken
        ? await readFacebookEmailPermission(accessToken)
        : 'unknown';
    logger.warn('native sign-in refused: the provider returned no email', {
      component: 'auth',
      provider: grant,
      emailPermission: permission,
    });
    return NextResponse.json(
      {
        error: {
          code: 'EMAIL_REQUIRED',
          message: 'The provider did not share an email address.',
          // `granted`: Facebook has none to give, so asking again cannot help.
          details: { emailPermission: permission },
        },
      },
      { status: 403 },
    );
  }

  // ═══ AN UNVERIFIED EMAIL IS AN ACCOUNT TAKEOVER ═══
  //
  // Identities are linked BY address, so a provider asserting one its owner
  // has not proved is a route into any account holding it. Google's
  // `email_verified` must be exactly true.
  if (!who.emailVerified) {
    logger.warn('native sign-in refused: email not verified', {
      component: 'auth',
      provider: grant,
    });
    return fail(403, 'EMAIL_UNVERIFIED', 'The provider has not verified this email address.');
  }

  const { userId } = await resolveProviderAccount({
    provider: who.provider,
    email: who.email,
    name: who.name,
    picture: who.picture,
    // The app's language, for a NEW account; an existing one keeps its own.
    locale: isLocale(body.locale) ? body.locale : null,
  });
  return userId;
}

export const POST = defineV1Route(handler);
