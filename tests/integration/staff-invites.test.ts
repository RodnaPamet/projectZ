import {
  acceptInvite,
  AlreadyInvitedError,
  createInvite,
  INVITE_TTL_DAYS,
  InviteNotUsableError,
  previewInvite,
  revokeInvite,
  RoleNotInvitableError,
} from '@/app-layer/usecases/invites';
import { membershipContext } from '@/lib/auth/page-context';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/** A session that cleared no Entra group gate — every non-Entra sign-in. */
const NO_GATE_CLEARED = { groupGateCleared: [] as string[] };

/**
 * THE INVITE FLOW, WHICH DID NOT EXIST.
 *
 * The `Invite` model and the `/invite/:token` edge carve-out both shipped; the
 * use case, the acceptance route and the mailer did not (#199). So a token
 * could be written and never delivered, and never redeemed.
 *
 * What these cover is the part where getting it wrong is a privilege bug
 * rather than an inconvenience: the token is a credential that arrives by
 * email, and whoever holds it gets a membership.
 */

describe('staff invites', () => {
  const db = prismaTestClient();
  let seq = 0;

  async function outsider(tag: string, accountKind: 'PLAYER' | 'CLUB' = 'PLAYER') {
    seq += 1;
    return asAppSuperuser(db, (tx) =>
      tx.user.create({
        data: { email: `${tag}-${seq}@test.invalid`, name: `Person ${tag}`, accountKind },
        select: { id: true, email: true },
      }),
    );
  }

  // STAFF by default: the invite a club sends most, and the one a brand-new
  // account can accept — it becomes a CLUB account (#263). A COACH invite
  // needs a COACH account, which nothing creates yet.
  const invite = (t: { tenantId: string; userId: string }, email: string, role = 'STAFF') =>
    runInTenantContext(t.tenantId, (c) =>
      createInvite(c, t.tenantId, t.userId, { email, role: role as never }),
    );

  /**
   * Accept as the action does: BYPASSRLS. The token is how the club is
   * discovered, and since #263 the account's standing is read across every
   * club — bound to one tenant, a player's memberships elsewhere would be
   * invisible and the account would look brand new.
   */
  const accept = (token: string, userId: string) =>
    runAsSuperuser((c) => acceptInvite(c, token, userId));

  beforeEach(async () => {
    await resetDatabase(db);
    seq = 0;
  });

  it('THE POINT: an invite is created, previewed, accepted, and grants membership', async () => {
    const t = await seedTenant({ name: 'Sofia Padel' }, db);
    const joiner = await outsider('joiner');

    const { token } = await invite(t, joiner.email);

    const preview = await runInTenantContext(t.tenantId, (c) => previewInvite(c, token));
    expect(preview).toMatchObject({ tenantSlug: t.tenantSlug, role: 'STAFF' });

    // Before: not a member.
    expect((await membershipContext(joiner.id, t.tenantSlug, NO_GATE_CLEARED)).kind).toBe(
      'not-a-member',
    );

    const result = await accept(token, joiner.id);
    expect(result).toMatchObject({ tenantSlug: t.tenantSlug, role: 'STAFF' });

    // After: a member, at the invited role, resolvable by the real resolver.
    const ctx = await membershipContext(joiner.id, t.tenantSlug, NO_GATE_CLEARED);
    expect(ctx.kind === 'ok' && ctx.ctx.role).toBe('STAFF');

    // …and a brand-new account that accepts a staff invite IS a club account
    // now (#263): it runs this club, and plays nowhere.
    const kind = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: joiner.id }, select: { accountKind: true } }),
    );
    expect(kind.accountKind).toBe('CLUB');
  });

  it('the plaintext token is never stored', async () => {
    // It is returned once and kept only as a keyed hash, so a leaked database
    // does not yield working invite links.
    const t = await seedTenant({}, db);
    const joiner = await outsider('j');
    const { token } = await invite(t, joiner.email);

    const rows = await asAppSuperuser(db, (tx) =>
      tx.invite.findMany({ select: { tokenHash: true } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).not.toContain(token);
  });

  it('is SINGLE USE — a second acceptance is refused', async () => {
    const t = await seedTenant({}, db);
    const a = await outsider('a');
    const b = await outsider('b');
    const { token } = await invite(t, a.email);

    await accept(token, a.id);

    // Same link, forwarded to somebody else.
    await expect(accept(token, b.id)).rejects.toThrow(InviteNotUsableError);

    expect((await membershipContext(b.id, t.tenantSlug, NO_GATE_CLEARED)).kind).toBe(
      'not-a-member',
    );
  });

  it('REFUSES to invite an OWNER', async () => {
    // `invite.role` has no CHECK — the P27 one is on the Entra mapping table —
    // so nothing in the database stops this. An invite is accepted by whoever
    // holds the link, which would defeat the two-party protection around
    // ownership entirely.
    const t = await seedTenant({}, db);
    const j = await outsider('j');

    await expect(invite(t, j.email, 'OWNER')).rejects.toThrow(RoleNotInvitableError);
    expect(await asAppSuperuser(db, (tx) => tx.invite.count())).toBe(0);
  });

  it('an expired invite is not usable, and does not say why', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    const { token, inviteId } = await invite(t, j.email);

    await asAppSuperuser(db, (tx) =>
      tx.invite.update({
        where: { id: inviteId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );

    expect(await runInTenantContext(t.tenantId, (c) => previewInvite(c, token))).toBeNull();
    await expect(accept(token, j.id)).rejects.toThrow(InviteNotUsableError);
  });

  it('a revoked invite is not usable', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    const { token, inviteId } = await invite(t, j.email);

    await runInTenantContext(t.tenantId, (c) => revokeInvite(c, t.tenantId, t.userId, inviteId));

    expect(await runInTenantContext(t.tenantId, (c) => previewInvite(c, token))).toBeNull();
    await expect(accept(token, j.id)).rejects.toThrow(InviteNotUsableError);
  });

  it('a wrong or malformed token is refused, and reveals nothing', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    await invite(t, j.email);

    for (const bad of ['', 'short', 'x'.repeat(43), 'not-a-real-token-but-long-enough-here']) {
      expect(await runInTenantContext(t.tenantId, (c) => previewInvite(c, bad))).toBeNull();
    }
  });

  it('refuses a second open invite to the same address', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    await invite(t, j.email);

    await expect(invite(t, j.email)).rejects.toThrow(AlreadyInvitedError);
  });

  it('a spent invite does not block a new one', async () => {
    // `@@unique([tenantId, email])` covers every invite, live or not, so
    // without clearing the old row a person could never be re-invited after
    // leaving.
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    const first = await invite(t, j.email);
    await accept(first.token, j.id);

    const second = await invite(t, j.email, 'MANAGER');
    expect(second.token).not.toBe(first.token);
  });

  it('accepting NEVER demotes an existing member', async () => {
    // An invite is an offer to join. Using one to quietly reduce somebody's
    // access would be a privilege change decided by whoever forwarded a link.
    // (A PLAYER invite to a manager is refused outright since #263 — another
    // kind of account — so the demotion tried here is within club roles.)
    const t = await seedTenant({}, db);
    const m = await outsider('m', 'CLUB');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: t.tenantId, userId: m.id, role: 'MANAGER', status: 'ACTIVE' },
      }),
    );

    const { token } = await invite(t, m.email, 'STAFF');
    await accept(token, m.id);

    const ctx = await membershipContext(m.id, t.tenantSlug, NO_GATE_CLEARED);
    expect(ctx.kind === 'ok' && ctx.ctx.role).toBe('MANAGER');
  });

  it('reactivates a suspended member rather than creating a second row', async () => {
    const t = await seedTenant({}, db);
    const m = await outsider('m', 'CLUB');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: t.tenantId, userId: m.id, role: 'STAFF', status: 'SUSPENDED' },
      }),
    );

    const { token } = await invite(t, m.email, 'STAFF');
    await accept(token, m.id);

    const rows = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.findMany({ where: { tenantId: t.tenantId, userId: m.id } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ACTIVE');
  });

  it('records who was invited, and separately who accepted', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    const { token } = await invite(t, j.email);
    await accept(token, j.id);

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: t.tenantId, entity: 'Invite' },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorUserId: true, detailsJson: true },
      }),
    );

    expect(audit.map((a) => a.action)).toEqual(['INVITE_SENT', 'INVITE_ACCEPTED']);
    expect(audit[0]!.actorUserId).toBe(t.userId);
    // The invitee, not the inviter: "who joined" is the question this answers.
    expect(audit[1]!.actorUserId).toBe(j.id);

    // And the token is not in the audit log, which is readable by anyone who
    // can read the audit log — it would be a working credential.
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('expires in the documented window', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    const { expiresAt } = await invite(t, j.email);

    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(INVITE_TTL_DAYS - 0.1);
    expect(days).toBeLessThan(INVITE_TTL_DAYS + 0.1);
  });
});
