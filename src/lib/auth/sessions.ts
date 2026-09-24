import { randomBytes } from 'node:crypto';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { hashForLookup } from '@/lib/security/encryption';

/**
 * Session revocation.
 *
 * ═══ WHY A STATELESS JWT NEEDS THIS AT ALL ═══
 *
 * A JWT is valid because it verifies, not because anybody still wants it to
 * be. Nothing in the token can express "this was revoked ten minutes ago", so
 * until something outside the token says otherwise, a signed session is good
 * until it expires and there is no mechanism to change that.
 *
 * For a web cookie that is a risk you can price. For a native client holding a
 * long-lived token on a device that gets sold, lost or stolen, it is not.
 *
 * ═══ TWO LEVERS, AND THEY ARE NOT THE SAME LEVER ═══
 *
 * The schema already encodes both, and has since P04:
 *
 *   User.sessionVersion         a per-USER counter. Bump it and EVERY token
 *                               issued before the bump stops being accepted.
 *                               This is what a password change pulls.
 *
 *   UserSession.revokedAt       a per-SESSION tombstone. Sign out ONE device
 *                               without touching the others.
 *
 * A token carries the version it was minted under. If the user's counter has
 * moved past it, the token is stale — no list of revoked tokens to store, no
 * cleanup job, and it works for tokens issued by instances that have since
 * died.
 *
 * ═══ WHY THE SECRET, WHEN THE JWE ALREADY AUTHENTICATES ITSELF ═══
 *
 * `tokenHash` is NOT NULL and unique, so a session row needs one. The obvious
 * candidate — a hash of the JWT — cannot be computed here: next-auth encodes
 * the token AFTER the jwt callback returns, so at row-creation time the token
 * does not exist yet.
 *
 * So the row stores a keyed hash of a random secret that also travels in the
 * token. For the web cookie this is belt and braces: the JWE is encrypted and
 * signed, so a forged `userSessionId` cannot be presented anyway. It earns its
 * place in the native flow, where refresh-token ROTATION needs exactly this —
 * a way to tell "the current token for this session" from "a token that was
 * valid for this session before the last refresh", which is how replay of a
 * stolen refresh token is detected.
 *
 * It is `hashForLookup` (HMAC-SHA256 with a server key), not bare SHA-256.
 * A bare digest of a 32-byte random value is not realistically brute-forcible
 * either, but the keyed version means a leaked database alone is not enough,
 * and it reuses the one key-management path this repo already has.
 */

/** Hex, so `hashForLookup`'s lowercase-and-trim normalisation is the identity. */
export function newSessionSecret(): string {
  return randomBytes(32).toString('hex');
}

export interface SessionClaims {
  userSessionId: string | null;
  sessionVersion: number;
  sessionSecret?: string | null;
}

export type SessionCheck =
  | { usable: true }
  | { usable: false; reason: 'no-session' | 'revoked' | 'expired' | 'stale-version' | 'unknown' };

/**
 * Record a new session.
 *
 * Runs as superuser because it has to. `user_session`'s WITH CHECK is
 * `"tenantId" = current_setting('app.tenant_id', true)` — deliberately NOT
 * symmetric with its USING clause, so that a session cannot be re-parented
 * into another tenant. A sign-in happens before any tenant is selected, so
 * `tenantId` is NULL, and NULL never equals the setting. `app_user` therefore
 * cannot write this row at all; only the bypass path can.
 */
export async function createUserSession(input: {
  userId: string;
  tenantId?: string | null;
  sessionSecret: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ userSessionId: string; sessionVersion: number; expiresAt: Date }> {
  return runAsSuperuser(async (db) => {
    // Snapshot the user's CURRENT counter. A token minted now is valid until
    // that counter moves.
    const user = await db.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { sessionVersion: true },
    });

    const row = await db.userSession.create({
      data: {
        userId: input.userId,
        tenantId: input.tenantId ?? null,
        tokenHash: hashForLookup(input.sessionSecret),
        sessionVersion: user.sessionVersion,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      // `expiresAt` comes back out rather than being assumed from the input:
      // it is the refresh deadline this session will be judged against, and
      // the native sign-in endpoint reports it to the client verbatim.
      select: { id: true, sessionVersion: true, expiresAt: true },
    });

    return {
      userSessionId: row.id,
      sessionVersion: row.sessionVersion,
      expiresAt: row.expiresAt,
    };
  });
}

/**
 * Is this token still wanted?
 *
 * ONE indexed lookup that answers every question at once — the row exists, was
 * not revoked, has not expired, its secret matches, and the user's counter has
 * not moved past it.
 *
 * ═══ THE COST, STATED PLAINLY ═══
 *
 * This is a database round trip on a path that previously had none, which is
 * the whole reason people reach for stateless JWTs. It is worth it here
 * because the alternative is a token nobody can take back, and it is ONE
 * query against a primary key.
 *
 * `usable: false` is returned rather than thrown. The caller decides whether a
 * dead session means 401, a redirect, or an anonymous context — and an
 * exception thrown this deep would have to be caught at every call site to
 * make that decision anyway.
 */
export async function checkSession(claims: SessionClaims): Promise<SessionCheck> {
  // A token minted before this feature existed carries no session id. Treat it
  // as unusable rather than trusted: "we cannot check" must not read as "it is
  // fine", or the check is decorative for exactly the tokens most likely to be
  // old.
  if (!claims.userSessionId) return { usable: false, reason: 'no-session' };

  const row = await runAsSuperuser((db) =>
    db.userSession.findUnique({
      where: { id: claims.userSessionId! },
      select: {
        tokenHash: true,
        sessionVersion: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { sessionVersion: true } },
      },
    }),
  );

  if (!row) return { usable: false, reason: 'unknown' };
  if (row.revokedAt) return { usable: false, reason: 'revoked' };
  if (row.expiresAt.getTime() <= Date.now()) return { usable: false, reason: 'expired' };

  // The secret binds the token to THIS row. Absent on a token minted before
  // the secret existed, which is the 'no-session' case above for new tokens
  // and this one for a half-migrated session.
  if (claims.sessionSecret && hashForLookup(claims.sessionSecret) !== row.tokenHash) {
    return { usable: false, reason: 'unknown' };
  }

  // The password-change lever. Compare against the USER's current counter, not
  // the row's snapshot — the row's copy records what it was minted under.
  if (row.user.sessionVersion !== claims.sessionVersion) {
    return { usable: false, reason: 'stale-version' };
  }

  return { usable: true };
}

/** Sign out one device. The others keep working. */
export async function revokeSession(userSessionId: string): Promise<void> {
  await runAsSuperuser((db) =>
    db.userSession.updateMany({
      where: { id: userSessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
}

/**
 * Sign out EVERYTHING, and keep it signed out.
 *
 * Bumping the counter is what makes this work for tokens we have never seen:
 * an instance that died holding a session, a token minted before this deploy,
 * a device that is offline right now. Tombstoning the rows as well is not
 * redundant — it is what makes the session list in a UI tell the truth, and
 * what a support person looks at when somebody asks "is my old laptop still
 * signed in?".
 *
 * Call this on password change, on "sign out everywhere", and on any
 * credential compromise.
 */
export async function revokeAllSessions(userId: string): Promise<{ newSessionVersion: number }> {
  return runAsSuperuser(async (db) => {
    const user = await db.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });

    await db.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { newSessionVersion: user.sessionVersion };
  });
}

/** Cheap liveness marker for a session list. Best-effort; never blocks a request. */
export async function touchSession(userSessionId: string): Promise<void> {
  await runAsSuperuser((db) =>
    db.userSession.updateMany({
      where: { id: userSessionId, revokedAt: null },
      data: { lastSeenAt: new Date() },
    }),
  ).catch(() => {
    // A failed heartbeat must never fail the request it was riding on.
  });
}

/**
 * ═══ NATIVE REFRESH ═══
 *
 * A native access token is deliberately SHORT, because the edge middleware
 * never checks revocation: `middleware.ts` reads the token and inspects claims,
 * and `checkSession` runs only inside a route. `exp` is therefore the only
 * revocation the edge honours, and a long access token is a long window in
 * which a revoked session still clears the tenant and permission checks.
 *
 * The refresh token is long and ROTATES, which is what makes a stolen one
 * detectable: presenting a token that was already rotated away means two
 * parties hold it.
 */

/**
 * The WEB cookie's lifetime.
 *
 * Lives here rather than in src/auth.ts so that reading it does not drag in
 * authOptions — and with it PrismaAdapter and @auth/prisma-adapter. A constant
 * should not pull an ESM-only adapter into every bundle that needs a number.
 */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Access token. Short, because the edge only honours `exp`. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Refresh token. Long, because it is checked against the database every time.
 *
 * Nothing compares a token against this number. It SIZES the row a native
 * sign-in creates, through NATIVE_SESSION_TTL_SECONDS; what the server then
 * enforces is that row's `expiresAt`, which is fixed at creation and never
 * written again. The refresh window is therefore an ABSOLUTE 30 days from
 * sign-in rather than a sliding one, and both native endpoints advertise the
 * column instead of recomputing a window from this constant.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long an already-rotated refresh token keeps working.
 *
 * 60s, and the number is doing real work. An iOS app resumed from the switcher
 * fires several requests at once; they all 401 and all call /auth/refresh with
 * the same token within milliseconds. Strict rotation calls the second one
 * replay and kills the session — a user logged out for using their phone
 * normally, and not reproducible on a desk where requests happen one at a time.
 *
 * Long enough to absorb that burst plus a retry on a bad network. Short enough
 * that a genuinely stolen token is useful for a minute rather than a month.
 */
export const REFRESH_GRACE_SECONDS = 60;

export type RefreshOutcome =
  | {
      ok: true;
      userId: string;
      userSessionId: string;
      /**
       * NULL means "keep the token you already have".
       *
       * Not an empty string — a falsy-but-present value is what ends up
       * written to a keychain. Null is only ever returned inside the grace
       * window, and it is not a shortcut: the server stores the HASH of the
       * current refresh token, so it genuinely cannot hand back the plaintext
       * to a caller that presented the previous one.
       *
       * The client does not need it. The caller that rotated is receiving the
       * new token in its own response; every other caller in the burst keeps
       * whatever its latest value is and converges on the same one.
       */
      refreshToken: string | null;
      rotated: boolean;
    }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'stale-version' | 'replayed' };

/**
 * Exchange a refresh token for a new one, or recognise a replay.
 *
 * ═══ THE THREE CASES, AND WHY THE MIDDLE ONE EXISTS ═══
 *
 *   matches refreshTokenHash          rotate, return the new token
 *   matches previous, inside grace    do NOT rotate, return the CURRENT token
 *   matches previous, outside grace   REPLAY — revoke the whole session
 *
 * The middle case is the entire point. Without it, concurrent refreshes from
 * one legitimate client are indistinguishable from theft, and the safe-looking
 * choice (revoke) logs people out constantly. With it, every caller in the
 * burst converges on the same current token instead of racing to rotate again.
 *
 * ═══ WHAT THIS CANNOT TELL YOU ═══
 *
 * A replay OUTSIDE the window is not proof of theft. A client that was
 * suspended for two minutes mid-refresh looks identical to an attacker
 * replaying a stolen token. We revoke anyway, because the alternative is
 * accepting a token we know was superseded — and a user who has to sign in
 * again is a far cheaper mistake than a session an attacker keeps.
 */
export async function rotateRefreshToken(input: {
  presented: string;
  now?: Date;
}): Promise<RefreshOutcome> {
  const now = input.now ?? new Date();
  const presentedHash = hashForLookup(input.presented);

  return runAsSuperuser(async (db) => {
    const row = await db.userSession.findFirst({
      where: {
        OR: [{ refreshTokenHash: presentedHash }, { previousRefreshTokenHash: presentedHash }],
      },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        sessionVersion: true,
        refreshTokenHash: true,
        previousRefreshTokenHash: true,
        previousRefreshExpiresAt: true,
        user: { select: { sessionVersion: true } },
      },
    });

    if (!row) return { ok: false, reason: 'unknown' };
    if (row.revokedAt) return { ok: false, reason: 'revoked' };
    // THE refresh deadline. It is the row's own column, not a window measured
    // from this request, and nothing in this function moves it — which is why
    // both native endpoints return this value as `refreshExpiresAt`.
    if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

    // The password-change lever still applies to refresh. A session whose user
    // bumped their counter must not be able to mint new access tokens.
    if (row.user.sessionVersion !== row.sessionVersion) {
      return { ok: false, reason: 'stale-version' };
    }

    const isCurrent = row.refreshTokenHash === presentedHash;

    if (!isCurrent) {
      const graceOpen =
        row.previousRefreshExpiresAt !== null &&
        row.previousRefreshExpiresAt.getTime() > now.getTime();

      if (!graceOpen) {
        // ═══ REPLAY ═══
        //
        // A token that was rotated away, presented after the window closed.
        // Revoke the SESSION, not just the token: if it was stolen, the thief
        // may already hold the current one too, and leaving it live would mean
        // detecting the theft and doing nothing about it.
        await db.userSession.update({
          where: { id: row.id },
          data: { revokedAt: now },
        });
        return { ok: false, reason: 'replayed' };
      }

      // Inside the window. Issue an access token, rotate NOTHING, and return
      // no refresh token — rotating again here is what turns one client's
      // burst into a rotation storm.
      return {
        ok: true,
        userId: row.userId,
        userSessionId: row.id,
        refreshToken: null,
        rotated: false,
      };
    }

    const next = newSessionSecret();

    // ═══ COMPARE-AND-SWAP, NOT UPDATE ═══
    //
    // `refreshTokenHash: presentedHash` in the WHERE is the whole point. The
    // read above and this write are not atomic, so several concurrent callers
    // can all reach here having seen the same current token. A plain update
    // lets every one of them rotate, last writer wins, and the losers walk
    // away holding tokens the server never stored — their next refresh fails
    // as `unknown` and they are logged out.
    //
    // Measured before this guard existed: 25 concurrent refreshes produced TEN
    // rotations. Three produced one, which is why a three-way test passed five
    // times in a row and proved nothing.
    //
    // With the condition, exactly one write matches. The rest see count 0 and
    // fall through to the grace-window answer — which is correct, because
    // losing this race IS the burst, not a replay.
    const updated = await db.userSession.updateMany({
      where: { id: row.id, refreshTokenHash: presentedHash },
      data: {
        refreshTokenHash: hashForLookup(next),
        previousRefreshTokenHash: presentedHash,
        previousRefreshExpiresAt: new Date(now.getTime() + REFRESH_GRACE_SECONDS * 1000),
        lastSeenAt: now,
      },
    });

    if (updated.count === 0) {
      return {
        ok: true,
        userId: row.userId,
        userSessionId: row.id,
        refreshToken: null,
        rotated: false,
      };
    }

    return {
      ok: true,
      userId: row.userId,
      userSessionId: row.id,
      refreshToken: next,
      rotated: true,
    };
  });
}

/** Attach the first refresh token to a session created by the native path. */
export async function setRefreshToken(userSessionId: string, token: string): Promise<void> {
  await runAsSuperuser((db) =>
    db.userSession.update({
      where: { id: userSessionId },
      data: { refreshTokenHash: hashForLookup(token) },
    }),
  );
}
