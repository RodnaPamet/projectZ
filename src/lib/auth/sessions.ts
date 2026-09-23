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
}): Promise<{ userSessionId: string; sessionVersion: number }> {
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
      select: { id: true, sessionVersion: true },
    });

    return { userSessionId: row.id, sessionVersion: row.sessionVersion };
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
