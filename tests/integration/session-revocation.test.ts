import {
  checkSession,
  createUserSession,
  newSessionSecret,
  revokeAllSessions,
  revokeSession,
} from '@/lib/auth/sessions';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Taking a token back.
 *
 * A JWT is valid because it verifies, not because anybody still wants it to
 * be. These assert the two levers the schema has carried since P04 and nothing
 * has ever used: a per-USER counter that evicts everything, and a per-SESSION
 * tombstone that evicts one device.
 */
describe('session revocation', () => {
  const db = prismaTestClient();

  async function freshUser() {
    const t = await seedTenant({}, db);
    return t.userId;
  }

  const issue = async (userId: string, ttlMs = 60_000) => {
    const sessionSecret = newSessionSecret();
    const { userSessionId, sessionVersion } = await createUserSession({
      userId,
      sessionSecret,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return { userSessionId, sessionVersion, sessionSecret };
  };

  it('a freshly issued session is usable', async () => {
    const claims = await issue(await freshUser());
    expect(await checkSession(claims)).toEqual({ usable: true });
  });

  it('revoking ONE session leaves the others alone', async () => {
    // "Sign out this device" must not sign you out of your phone.
    const userId = await freshUser();
    const laptop = await issue(userId);
    const phone = await issue(userId);

    await revokeSession(laptop.userSessionId);

    expect(await checkSession(laptop)).toEqual({ usable: false, reason: 'revoked' });
    expect(await checkSession(phone)).toEqual({ usable: true });
  });

  it('revokeAllSessions evicts EVERY token, including ones it never saw', async () => {
    // The password-change lever. It works by moving the user's counter, so it
    // reaches tokens held by instances that have since died and devices that
    // are offline right now — no revocation list to distribute.
    const userId = await freshUser();
    const laptop = await issue(userId);
    const phone = await issue(userId);

    await revokeAllSessions(userId);

    expect(await checkSession(laptop)).toEqual({ usable: false, reason: 'revoked' });
    expect(await checkSession(phone)).toEqual({ usable: false, reason: 'revoked' });
  });

  it('a token minted BEFORE the bump is stale even if its row was never tombstoned', async () => {
    // The counter alone must be sufficient. Tombstoning rows is what makes a
    // session list tell the truth; it is not what does the revoking.
    const userId = await freshUser();
    const claims = await issue(userId);

    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } }),
    );

    expect(await checkSession(claims)).toEqual({ usable: false, reason: 'stale-version' });
  });

  it('a session issued AFTER a bump is usable — revocation is not permanent', async () => {
    // Signing in again after a password change must work.
    const userId = await freshUser();
    await revokeAllSessions(userId);

    expect(await checkSession(await issue(userId))).toEqual({ usable: true });
  });

  it('an expired session is not usable, even un-revoked', async () => {
    const claims = await issue(await freshUser(), -1000);
    expect(await checkSession(claims)).toEqual({ usable: false, reason: 'expired' });
  });

  it('a token with NO session id is refused, not trusted', async () => {
    // "We cannot check this" must never read as "this is fine", or the check
    // is decorative for exactly the tokens most likely to be old.
    expect(await checkSession({ userSessionId: null, sessionVersion: 0 })).toEqual({
      usable: false,
      reason: 'no-session',
    });
  });

  it('a forged session id is refused', async () => {
    expect(
      await checkSession({ userSessionId: 'cforgedsessionaaaaaaaaaa', sessionVersion: 0 }),
    ).toEqual({ usable: false, reason: 'unknown' });
  });

  it('a WRONG secret is refused even with a real session id', async () => {
    // Binds the token to the row. Belt and braces for the encrypted web JWE;
    // it is the mechanism refresh-token rotation will use in the native flow.
    const claims = await issue(await freshUser());

    expect(await checkSession({ ...claims, sessionSecret: newSessionSecret() })).toEqual({
      usable: false,
      reason: 'unknown',
    });
  });

  it('stores a HASH, never the secret itself', async () => {
    // A leaked database must not be a set of working sessions.
    const userId = await freshUser();
    const claims = await issue(userId);

    const row = await asAppSuperuser(db, (tx) =>
      tx.userSession.findUniqueOrThrow({ where: { id: claims.userSessionId } }),
    );

    expect(row.tokenHash).not.toBe(claims.sessionSecret);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(claims.sessionSecret);
  });
});
