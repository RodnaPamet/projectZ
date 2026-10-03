import { randomUUID } from 'node:crypto';

import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { GET as statusRoute } from '@/app/api/v1/me/mfa/route';
import { POST as regenerateRoute } from '@/app/api/v1/me/mfa/recovery-codes/route';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';
import { hashRecoveryCode, newTotpSecret, totpAt, totpStep } from '@/lib/auth/totp';
import { decryptField } from '@/lib/security/encryption';

import { prismaTestClient } from '../helpers/db';
import { callConfirm, callEnrol, callStepUp, enrolAndStepUp, nextCode } from '../helpers/mfa';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE SECOND FACTOR, THROUGH THE REAL ROUTES (#262).
 *
 * What has to be true: the TOTP seed is ciphertext at rest; enrolment is for
 * grant holders on a fresh sign-in; a code is accepted once; a recovery code
 * is spent once, even by two requests racing; guessing is rate-limited per
 * user; every attempt — refused or accepted — leaves an append-only row; and
 * the step-up belongs to one session.
 */

const db = prismaTestClient();
const HOUR = 3_600_000;
const uid = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 21)}`;

let admin: string;
let granter: string;

beforeEach(async () => {
  admin = uid('cmfa');
  granter = uid('cgrn');
  await asAppSuperuser(db, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO app_user (id,email,"createdAt","updatedAt")
       VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
      admin,
      `${admin}@test.invalid`,
      granter,
      `${granter}@test.invalid`,
    ),
  );
});

async function grant() {
  await asAppSuperuser(db, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO platform_admin_grant
         (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
       VALUES ($1,$2,$3,'review moderation rota',ARRAY['REVIEW_MODERATE']::"PlatformCapability"[], now() + interval '7 days')`,
      uid('cg'),
      admin,
      granter,
    ),
  );
}

/** A Bearer token the way /auth/token mints one, and the session it names. */
async function signIn(userId = admin) {
  const { userSessionId, sessionVersion } = await createUserSession({
    userId,
    sessionSecret: newSessionSecret(),
    expiresAt: new Date(Date.now() + HOUR),
  });
  const bearer = await encode({
    secret: process.env.NEXTAUTH_SECRET!,
    maxAge: 900,
    token: { sub: userId, userSessionId, sessionVersion },
  });
  return { bearer, userSessionId };
}

const code = (json: Record<string, unknown>) => (json.error as { code: string }).code;

const events = () =>
  asAppSuperuser(db, (tx) =>
    tx.accountSecurityEvent.findMany({
      where: { userId: admin },
      orderBy: { createdAt: 'asc' },
      select: { action: true, userSessionId: true, detailsJson: true },
    }),
  );

async function status(bearer: string) {
  const res = await statusRoute(
    new NextRequest('http://t/api/v1/me/mfa', { headers: { authorization: `Bearer ${bearer}` } }),
    {},
  );
  return (await res.json()) as {
    data: {
      eligible: boolean;
      enrolled: boolean;
      pending: boolean;
      stepUpExpiresAt: string | null;
      recoveryCodesRemaining: number;
    };
  };
}

async function regenerate(bearer: string) {
  const res = await regenerateRoute(
    new NextRequest('http://t/api/v1/me/mfa/recovery-codes', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    }),
    {},
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ══ Enrolment ════════════════════════════════════════════════════════

describe('enrolment', () => {
  it('is for holders of a live platform grant', async () => {
    const { bearer } = await signIn();
    const r = await callEnrol(bearer);
    expect(r.status).toBe(403);
    expect(code(r.json)).toBe('MFA_NOT_ELIGIBLE');
    expect((await status(bearer)).data.eligible).toBe(false);
  });

  it('needs a FRESH sign-in — a days-old session cannot plant an authenticator', async () => {
    await grant();
    const { bearer, userSessionId } = await signIn();
    await asAppSuperuser(db, (tx) =>
      tx.userSession.update({
        where: { id: userSessionId },
        data: { createdAt: new Date(Date.now() - 16 * 60_000) },
      }),
    );

    const r = await callEnrol(bearer);
    expect(r.status).toBe(403);
    expect(code(r.json)).toBe('MFA_REAUTH_REQUIRED');
    const u = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: admin }, select: { mfaSecret: true } }),
    );
    expect(u.mfaSecret).toBeNull();
  });

  it('stores the seed as AES-GCM ciphertext, never the seed itself', async () => {
    await grant();
    const { bearer } = await signIn();
    const r = await callEnrol(bearer);
    expect(r.status).toBe(200);
    const { secret, otpauthUri } = r.json.data as { secret: string; otpauthUri: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toContain(`secret=${secret}`);

    const stored = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: admin },
        select: { mfaSecret: true, mfaEnabledAt: true },
      }),
    );
    expect(stored.mfaSecret!.startsWith('v1:')).toBe(true);
    expect(stored.mfaSecret).not.toContain(secret);
    expect(decryptField(stored.mfaSecret!)).toBe(secret);
    // Pending until a code is confirmed.
    expect(stored.mfaEnabledAt).toBeNull();
    expect((await status(bearer)).data).toMatchObject({ enrolled: false, pending: true });
  });

  it('the database itself refuses a plaintext seed', async () => {
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.user.update({ where: { id: admin }, data: { mfaSecret: newTotpSecret() } }),
      ),
    ).rejects.toThrow(/app_user_mfa_secret_is_envelope/);
  });

  it('a wrong first code turns nothing on, and is recorded', async () => {
    await grant();
    const { bearer } = await signIn();
    const { secret } = (await callEnrol(bearer)).json.data as { secret: string };
    const right = totpAt(secret, Date.now());
    const wrong = right === '000000' ? '111111' : '000000';

    const r = await callConfirm(bearer, wrong);
    expect(r.status).toBe(403);
    expect(code(r.json)).toBe('MFA_CODE_REJECTED');
    expect((await status(bearer)).data.enrolled).toBe(false);
    expect((await events()).map((e) => e.action)).toEqual([
      'MFA_ENROLMENT_STARTED',
      'MFA_ENROLMENT_CONFIRM_FAILED',
    ]);
  });

  it('confirming turns it on, issues ten HASHED recovery codes, and steps this session up', async () => {
    await grant();
    const { bearer, userSessionId } = await signIn();
    const { recoveryCodes } = await enrolAndStepUp(bearer);

    expect(recoveryCodes).toHaveLength(10);
    const rows = await asAppSuperuser(db, (tx) =>
      tx.mfaRecoveryCode.findMany({ where: { userId: admin } }),
    );
    expect(rows).toHaveLength(10);
    // Only hashes at rest — and the hashes of exactly the codes we were shown.
    expect(new Set(rows.map((r) => r.codeHash))).toEqual(
      new Set(recoveryCodes.map((c) => hashRecoveryCode(admin, c))),
    );
    for (const c of recoveryCodes) {
      expect(rows.some((r) => r.codeHash.includes(c.replace(/-/g, '')))).toBe(false);
    }

    const s = (await status(bearer)).data;
    expect(s).toMatchObject({ enrolled: true, pending: false, recoveryCodesRemaining: 10 });
    expect(s.stepUpExpiresAt).not.toBeNull();

    const evs = await events();
    expect(evs.map((e) => e.action)).toEqual(['MFA_ENROLMENT_STARTED', 'MFA_ENROLMENT_CONFIRMED']);
    expect(evs.every((e) => e.userSessionId === userSessionId)).toBe(true);
  });

  it('cannot be redone once on — replacing the phone is an operator reset', async () => {
    await grant();
    const { bearer } = await signIn();
    await enrolAndStepUp(bearer);

    const again = await callEnrol(bearer);
    expect(again.status).toBe(409);
    expect(code(again.json)).toBe('MFA_ALREADY_ENROLLED');
  });
});

// ══ Step-up ══════════════════════════════════════════════════════════

describe('step-up', () => {
  it('is bound to the session that made it', async () => {
    await grant();
    const laptop = await signIn();
    const { secret } = await enrolAndStepUp(laptop.bearer);
    const phone = await signIn();

    expect((await status(laptop.bearer)).data.stepUpExpiresAt).not.toBeNull();
    expect((await status(phone.bearer)).data.stepUpExpiresAt).toBeNull();

    const r = await callStepUp(phone.bearer, { code: nextCode(secret) });
    expect(r.status).toBe(200);
    expect((await status(phone.bearer)).data.stepUpExpiresAt).not.toBeNull();
  });

  it('a TOTP code is accepted ONCE — replaying it, even on another session, is refused', async () => {
    await grant();
    const first = await signIn();
    const { secret } = await enrolAndStepUp(first.bearer);
    const second = await signIn();
    const third = await signIn();

    const c = nextCode(secret);
    expect((await callStepUp(second.bearer, { code: c })).status).toBe(200);

    const replay = await callStepUp(third.bearer, { code: c });
    expect(replay.status).toBe(403);
    expect(code(replay.json)).toBe('MFA_CODE_REJECTED');
    expect((await status(third.bearer)).data.stepUpExpiresAt).toBeNull();

    // Two racing requests with the same fresh code: exactly one wins.
    const later = totpAt(secret, (totpStep(Date.now()) + 1) * 30_000);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({
        where: { id: admin },
        data: { mfaLastUsedStep: BigInt(totpStep(Date.now())) },
      }),
    );
    const racers = await Promise.all([
      callStepUp((await signIn()).bearer, { code: later }),
      callStepUp((await signIn()).bearer, { code: later }),
    ]);
    expect(racers.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('a recovery code works once, case and hyphens ignored, and two racers cannot both spend it', async () => {
    await grant();
    const { bearer } = await signIn();
    const { recoveryCodes } = await enrolAndStepUp(bearer);
    const [one, two] = recoveryCodes as [string, string];

    const lower = one.toLowerCase().replace(/-/g, ' ');
    const used = await callStepUp((await signIn()).bearer, { recoveryCode: lower });
    expect(used.status).toBe(200);
    expect(used.json.data).toMatchObject({ method: 'recovery_code', recoveryCodesRemaining: 9 });

    const reused = await callStepUp((await signIn()).bearer, { recoveryCode: one });
    expect(reused.status).toBe(403);
    expect(code(reused.json)).toBe('MFA_CODE_REJECTED');

    const racers = await Promise.all([
      callStepUp((await signIn()).bearer, { recoveryCode: two }),
      callStepUp((await signIn()).bearer, { recoveryCode: two }),
    ]);
    expect(racers.map((r) => r.status).sort()).toEqual([200, 403]);

    const actions = (await events()).map((e) => e.action);
    expect(actions.filter((a) => a === 'MFA_RECOVERY_CODE_USED')).toHaveLength(2);
  });

  it('refuses an account that has not enrolled', async () => {
    await grant();
    const { bearer } = await signIn();
    const r = await callStepUp(bearer, { code: '123456' });
    expect(r.status).toBe(403);
    expect(code(r.json)).toBe('MFA_ENROLMENT_REQUIRED');
  });

  it('wants exactly one of code and recoveryCode', async () => {
    await grant();
    const { bearer } = await signIn();
    expect((await callStepUp(bearer, {})).status).toBe(400);
    expect((await callStepUp(bearer, { code: '1', recoveryCode: '2' })).status).toBe(400);
  });

  it('is rate-limited per user: after five wrong guesses even the RIGHT code is refused', async () => {
    await grant();
    const { bearer } = await signIn();
    const { secret } = await enrolAndStepUp(bearer);
    const right = nextCode(secret);
    const wrong = right === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const r = await callStepUp((await signIn()).bearer, { code: wrong });
      expect(r.status).toBe(403);
    }
    // A new session does not reset it: the budget is the user's, not the session's.
    const locked = await callStepUp((await signIn()).bearer, { code: right });
    expect(locked.status).toBe(429);
    expect(code(locked.json)).toBe('RATE_LIMITED');

    const actions = (await events()).map((e) => e.action);
    expect(actions.filter((a) => a === 'MFA_STEP_UP_FAILED')).toHaveLength(5);
    expect(actions).toContain('MFA_STEP_UP_RATE_LIMITED');
  });

  it('the security log is append-only', async () => {
    await grant();
    const { bearer } = await signIn();
    await enrolAndStepUp(bearer);
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.accountSecurityEvent.updateMany({ where: { userId: admin }, data: { action: 'X' } }),
      ),
    ).rejects.toThrow(/APPEND-ONLY/);
    await expect(
      asAppSuperuser(db, (tx) => tx.accountSecurityEvent.deleteMany({ where: { userId: admin } })),
    ).rejects.toThrow(/APPEND-ONLY/);
  });
});

// ══ Recovery codes ═══════════════════════════════════════════════════

describe('regenerating recovery codes', () => {
  it('needs a step-up on this session, and replaces every old code', async () => {
    await grant();
    const laptop = await signIn();
    const { recoveryCodes: old } = await enrolAndStepUp(laptop.bearer);

    const phone = await signIn();
    const refused = await regenerate(phone.bearer);
    expect(refused.status).toBe(403);
    expect(code(refused.json)).toBe('STEP_UP_REQUIRED');

    const fresh = await regenerate(laptop.bearer);
    expect(fresh.status).toBe(200);
    const codes = (fresh.json.data as { recoveryCodes: string[] }).recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(codes.some((c) => old.includes(c))).toBe(false);

    const stale = await callStepUp(phone.bearer, { recoveryCode: old[0] });
    expect(code(stale.json)).toBe('MFA_CODE_REJECTED');
    const ok = await callStepUp(phone.bearer, { recoveryCode: codes[0] });
    expect(ok.status).toBe(200);
  });

  it('two regenerations racing leave ONE set of ten, not twenty', async () => {
    // Found in review: without a lock on the account row, each DELETE sees
    // only the rows its statement started with and both new sets survive.
    await grant();
    const { bearer } = await signIn();
    await enrolAndStepUp(bearer);

    const [a, b] = await Promise.all([regenerate(bearer), regenerate(bearer)]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const live = await asAppSuperuser(db, (tx) =>
      tx.mfaRecoveryCode.count({ where: { userId: admin, usedAt: null } }),
    );
    expect(live).toBe(10);
  });
});
