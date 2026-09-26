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
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

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

  async function outsider(tag: string) {
    seq += 1;
    return asAppSuperuser(db, (tx) =>
      tx.user.create({
        data: { email: `${tag}-${seq}@test.invalid`, name: `Person ${tag}` },
        select: { id: true, email: true },
      }),
    );
  }

  const invite = (t: { tenantId: string; userId: string }, email: string, role = 'COACH') =>
    runInTenantContext(t.tenantId, (c) =>
      createInvite(c, t.tenantId, t.userId, { email, role: role as never }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
    seq = 0;
  });

  it('THE POINT: an invite is created, previewed, accepted, and grants membership', async () => {
    const t = await seedTenant({ name: 'Sofia Padel' }, db);
    const joiner = await outsider('joiner');

    const { token } = await invite(t, joiner.email);

    const preview = await runInTenantContext(t.tenantId, (c) => previewInvite(c, token));
    expect(preview).toMatchObject({ tenantSlug: t.tenantSlug, role: 'COACH' });

    // Before: not a member.
    expect((await membershipContext(joiner.id, t.tenantSlug)).kind).toBe('not-a-member');

    const result = await runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, joiner.id));
    expect(result).toMatchObject({ tenantSlug: t.tenantSlug, role: 'COACH' });

    // After: a member, at the invited role, resolvable by the real resolver.
    const ctx = await membershipContext(joiner.id, t.tenantSlug);
    expect(ctx.kind === 'ok' && ctx.ctx.role).toBe('COACH');
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

    await runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, a.id));

    // Same link, forwarded to somebody else.
    await expect(
      runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, b.id)),
    ).rejects.toThrow(InviteNotUsableError);

    expect((await membershipContext(b.id, t.tenantSlug)).kind).toBe('not-a-member');
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
    await expect(
      runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, j.id)),
    ).rejects.toThrow(InviteNotUsableError);
  });

  it('a revoked invite is not usable', async () => {
    const t = await seedTenant({}, db);
    const j = await outsider('j');
    const { token, inviteId } = await invite(t, j.email);

    await runInTenantContext(t.tenantId, (c) => revokeInvite(c, t.tenantId, t.userId, inviteId));

    expect(await runInTenantContext(t.tenantId, (c) => previewInvite(c, token))).toBeNull();
    await expect(
      runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, j.id)),
    ).rejects.toThrow(InviteNotUsableError);
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
    await runInTenantContext(t.tenantId, (c) => acceptInvite(c, first.token, j.id));

    const second = await invite(t, j.email, 'MANAGER');
    expect(second.token).not.toBe(first.token);
  });

  it('accepting NEVER demotes an existing member', async () => {
    // An invite is an offer to join. Using one to quietly reduce somebody's
    // access would be a privilege change decided by whoever forwarded a link.
    const t = await seedTenant({}, db);
    const m = await outsider('m');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: t.tenantId, userId: m.id, role: 'MANAGER', status: 'ACTIVE' },
      }),
    );

    const { token } = await invite(t, m.email, 'PLAYER');
    await runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, m.id));

    const ctx = await membershipContext(m.id, t.tenantSlug);
    expect(ctx.kind === 'ok' && ctx.ctx.role).toBe('MANAGER');
  });

  it('reactivates a suspended member rather than creating a second row', async () => {
    const t = await seedTenant({}, db);
    const m = await outsider('m');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: t.tenantId, userId: m.id, role: 'COACH', status: 'SUSPENDED' },
      }),
    );

    const { token } = await invite(t, m.email, 'COACH');
    await runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, m.id));

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
    await runInTenantContext(t.tenantId, (c) => acceptInvite(c, token, j.id));

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
