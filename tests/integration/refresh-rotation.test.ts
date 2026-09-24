import {
  createUserSession,
  newSessionSecret,
  REFRESH_GRACE_SECONDS,
  revokeAllSessions,
  rotateRefreshToken,
  setRefreshToken,
} from '@/lib/auth/sessions';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Refresh rotation, and the burst it exists to survive.
 *
 * The failure this design is built around is not theft — it is a legitimate
 * user being logged out. An iOS app resumed from the switcher fires several
 * requests at once; they all 401 and all refresh with the SAME token within
 * milliseconds. Strict rotation calls that replay.
 */
describe('refresh token rotation', () => {
  const db = prismaTestClient();

  async function issue() {
    const t = await seedTenant({}, db);
    const { userSessionId } = await createUserSession({
      userId: t.userId,
      sessionSecret: newSessionSecret(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const refresh = newSessionSecret();
    await setRefreshToken(userSessionId, refresh);
    return { userId: t.userId, userSessionId, refresh };
  }

  it('rotates on use and hands back a NEW token', async () => {
    const s = await issue();
    const r = await rotateRefreshToken({ presented: s.refresh });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rotated).toBe(true);
    expect(r.refreshToken).not.toBe(s.refresh);
    expect(r.refreshToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rotation does NOT extend the session — the deadline is absolute', async () => {
    // What /auth/token and /auth/refresh both advertise as `refreshExpiresAt`
    // is this column. They may only do that while rotation leaves it alone: the
    // moment a rotation slides it, the advertised value becomes a sliding
    // window again and #123 is back, this time in the database.
    const s = await issue();

    const before = await asAppSuperuser(db, (tx) =>
      tx.userSession.findUniqueOrThrow({
        where: { id: s.userSessionId },
        select: { expiresAt: true },
      }),
    );

    const r = await rotateRefreshToken({ presented: s.refresh });
    expect(r.ok && r.rotated).toBe(true);

    const after = await asAppSuperuser(db, (tx) =>
      tx.userSession.findUniqueOrThrow({
        where: { id: s.userSessionId },
        select: { expiresAt: true },
      }),
    );

    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('THE BURST: three concurrent refreshes with the same token all succeed', async () => {
    // ═══ THE WHOLE POINT ═══
    //
    // Without the grace window the second and third are read as replay and the
    // session is revoked — a user logged out for using their phone normally,
    // and not reproducible on a desk where requests happen one at a time.
    const s = await issue();

    const [a, b, c] = await Promise.all([
      rotateRefreshToken({ presented: s.refresh }),
      rotateRefreshToken({ presented: s.refresh }),
      rotateRefreshToken({ presented: s.refresh }),
    ]);

    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);

    // Exactly one rotated; the others were served from the grace window.
    const rotations = [a, b, c].filter((r) => r.ok && r.rotated).length;
    expect(rotations).toBe(1);

    // And the session is very much alive.
    const row = await asAppSuperuser(db, (tx) =>
      tx.userSession.findUniqueOrThrow({ where: { id: s.userSessionId } }),
    );
    expect(row.revokedAt).toBeNull();
  });

  it('a grace-window caller gets NULL, not an empty string', async () => {
    // A falsy-but-present value is what ends up written to a keychain. The
    // server stores only the hash of the current token, so it genuinely cannot
    // return the plaintext to a caller holding the previous one.
    const s = await issue();
    await rotateRefreshToken({ presented: s.refresh });

    const second = await rotateRefreshToken({ presented: s.refresh });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.rotated).toBe(false);
    expect(second.refreshToken).toBeNull();
  });

  it('REPLAY after the window closes revokes the whole session', async () => {
    const s = await issue();
    const first = await rotateRefreshToken({ presented: s.refresh });
    expect(first.ok).toBe(true);

    // Same token, presented after the grace window has closed.
    const later = new Date(Date.now() + (REFRESH_GRACE_SECONDS + 5) * 1000);
    const replay = await rotateRefreshToken({ presented: s.refresh, now: later });

    expect(replay).toEqual({ ok: false, reason: 'replayed' });

    // The session is revoked, not merely the token: a thief who replayed the
    // old one may already hold the current one too.
    const row = await asAppSuperuser(db, (tx) =>
      tx.userSession.findUniqueOrThrow({ where: { id: s.userSessionId } }),
    );
    expect(row.revokedAt).not.toBeNull();
  });

  it('the CURRENT token stops working once the session is revoked by a replay', async () => {
    const s = await issue();
    const rotated = await rotateRefreshToken({ presented: s.refresh });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok || !rotated.refreshToken) return;

    const later = new Date(Date.now() + (REFRESH_GRACE_SECONDS + 5) * 1000);
    await rotateRefreshToken({ presented: s.refresh, now: later }); // replay → revoke

    expect(await rotateRefreshToken({ presented: rotated.refreshToken })).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('an unknown token is refused without touching anything', async () => {
    expect(await rotateRefreshToken({ presented: newSessionSecret() })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('a password change (sessionVersion bump) stops refresh too', async () => {
    // Otherwise "log out everywhere" leaves a native client able to mint new
    // access tokens indefinitely — the revocation would apply to every surface
    // except the one holding a 30-day credential.
    const s = await issue();
    await revokeAllSessions(s.userId);

    const r = await rotateRefreshToken({ presented: s.refresh });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['revoked', 'stale-version']).toContain(r.reason);
  });

  it('stores only hashes — a leaked database is not a set of live sessions', async () => {
    const s = await issue();
    const row = await asAppSuperuser(db, (tx) =>
      tx.userSession.findUniqueOrThrow({ where: { id: s.userSessionId } }),
    );

    expect(row.refreshTokenHash).not.toBe(s.refresh);
    expect(JSON.stringify(row)).not.toContain(s.refresh);
  });
});
