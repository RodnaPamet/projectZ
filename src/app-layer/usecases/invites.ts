import { randomBytes } from 'node:crypto';

import type { PrismaClient, Role } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { hashForLookup } from '@/lib/security/encryption';

/**
 * Inviting somebody to help run a club.
 *
 * ═══ THE TOKEN EXISTS ONCE ═══
 *
 * `createInvite` returns the plaintext token to its caller and stores only
 * `hashForLookup(token)` — HMAC-SHA256 with a server key, the same scheme
 * `sessions.ts` uses, so a leaked database alone does not yield working invite
 * links. Nothing can recover the token afterwards, which is why resending an
 * invite issues a new one rather than re-reading the old.
 *
 * ═══ AN INVITE CANNOT MAKE AN OWNER ═══
 *
 * `invite.role` has no CHECK constraint — the `role <> 'OWNER'` one from P27 is
 * on `tenant_entra_group_mapping` alone — so nothing in the database stops an
 * invite naming OWNER. That matters more here than for a role change: an
 * invite is accepted by whoever holds the link, and the two-party protection
 * around ownership would be defeated by a single email.
 *
 * So OWNER is refused outright. Ownership is granted by an existing owner, to
 * an existing member, on the staff screen, where `admin.owner_management` and
 * the last-owner guard both apply.
 *
 * ═══ WHAT ACCEPTANCE MAY AND MAY NOT DO ═══
 *
 * Accepting creates or reactivates a membership at the named role. It will not
 * DEMOTE anyone: if the invitee is already a MANAGER and the invite says
 * COACH, the invite is consumed and the higher role stands. An invite is an
 * offer to join, and using one to quietly reduce somebody's access would be a
 * privilege change with no audit trail on the deciding side.
 */

export const INVITE_TTL_DAYS = 14;

/** Roles an invite may name. OWNER is deliberately absent — see above. */
export const INVITABLE_ROLES: readonly Role[] = ['MANAGER', 'COACH', 'STAFF', 'PLAYER'];

export class RoleNotInvitableError extends Error {
  constructor(role: string) {
    super(
      `An invite cannot grant ${role}. Ownership is granted by an existing owner, to an ` +
        'existing member, where admin.owner_management and the last-owner guard apply — not ' +
        'by anyone who happens to hold a link.',
    );
    this.name = 'RoleNotInvitableError';
  }
}

export class InviteNotUsableError extends Error {
  constructor() {
    super(
      'That invite link is not usable. It may have expired, been revoked, or already been ' +
        'accepted — and the four are deliberately indistinguishable, because telling them ' +
        'apart lets somebody probe for live tokens.',
    );
    this.name = 'InviteNotUsableError';
  }
}

export class AlreadyInvitedError extends Error {
  constructor() {
    super('There is already an open invite for that address. Revoke it before sending another.');
    this.name = 'AlreadyInvitedError';
  }
}

/** A URL-safe token. 32 bytes: not guessable, and short enough to paste. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createInvite(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  input: { email: string; role: Role },
): Promise<{ inviteId: string; token: string; expiresAt: Date }> {
  if (!INVITABLE_ROLES.includes(input.role)) throw new RoleNotInvitableError(input.role);

  const email = input.email.trim().toLowerCase();
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

  // `@@unique([tenantId, email])` covers ALL invites, not just live ones, so a
  // spent or revoked invite blocks a new one to the same address. Clearing it
  // here rather than widening the index: the row's only remaining value is its
  // audit trail, and that lives in `audit_entry`, which nothing deletes.
  await db.invite.deleteMany({
    where: { tenantId, email, OR: [{ acceptedAt: { not: null } }, { revokedAt: { not: null } }] },
  });

  const open = await db.invite.findFirst({
    where: { tenantId, email, acceptedAt: null, revokedAt: null },
    select: { id: true, expiresAt: true },
  });
  if (open && open.expiresAt > new Date()) throw new AlreadyInvitedError();
  // `tenantId` as well as the id: the row came from a tenant-scoped read, so
  // this is belt and braces — but `tenant-isolation-structural` requires it,
  // and its argument holds. The day this runs under `app_superuser`, the
  // filter is the only thing scoping it.
  if (open) {
    await db.invite.deleteMany({ where: { id: open.id, tenantId } });
  }

  const invite = await db.invite.create({
    data: {
      tenantId,
      email,
      role: input.role,
      tokenHash: hashForLookup(token),
      invitedById: actorUserId,
      expiresAt,
    },
    select: { id: true },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'Invite',
    entityId: invite.id,
    action: AUDIT_ACTIONS.INVITE_SENT,
    details: `Invited ${email} as ${input.role}`,
    detailsJson: {
      category: 'access',
      summary: 'Invite sent',
      // The token is NOT recorded. An audit row is readable by anyone who can
      // read the audit log, and this one would be a working credential.
      after: { email, role: input.role, expiresAt: expiresAt.toISOString() },
    },
  });

  return { inviteId: invite.id, token, expiresAt };
}

export async function revokeInvite(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  inviteId: string,
) {
  const before = await db.invite.findFirst({
    where: { tenantId, id: inviteId, acceptedAt: null, revokedAt: null },
    select: { id: true, email: true, role: true },
  });
  if (!before) throw new InviteNotUsableError();

  await db.invite.updateMany({
    where: { id: inviteId, tenantId },
    data: { revokedAt: new Date() },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'Invite',
    entityId: inviteId,
    action: AUDIT_ACTIONS.INVITE_REVOKED,
    details: `Revoked the invite for ${before.email}`,
    detailsJson: {
      category: 'access',
      summary: 'Invite revoked',
      before: { email: before.email, role: before.role },
    },
  });

  return before;
}

export interface InvitePreview {
  inviteId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  email: string;
  role: Role;
}

/**
 * What a token names, without consuming it.
 *
 * The acceptance page needs to say "X invited you to Y as a COACH" before the
 * visitor commits, and that page is reachable signed-out — the edge carve-out
 * at `/invite/:token` exists for exactly this.
 *
 * Returns null rather than throwing on every unusable case, so the page can
 * render one indistinguishable message.
 */
export async function previewInvite(
  db: PrismaClient,
  token: string,
): Promise<InvitePreview | null> {
  if (typeof token !== 'string' || token.length < 16) return null;

  const invite = await db.invite.findFirst({
    where: {
      tokenHash: hashForLookup(token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
      tenant: { select: { name: true, slug: true } },
    },
  });
  if (!invite) return null;

  return {
    inviteId: invite.id,
    tenantId: invite.tenantId,
    tenantName: invite.tenant.name,
    tenantSlug: invite.tenant.slug,
    email: invite.email,
    role: invite.role,
  };
}

/**
 * Consume an invite for a signed-in user.
 *
 * ═══ THE EMAIL IS NOT CHECKED AGAINST THE ACCOUNT ═══
 *
 * Deliberately. An invite is sent to an address, and people sign in with a
 * different one all the time — a Google account, a work address, an address
 * they changed last year. Refusing on a mismatch would make invites fail for
 * ordinary reasons that look like a bug.
 *
 * What protects this is the token: 32 random bytes, stored only as a keyed
 * hash, single-use, expiring. Whoever holds the link was given it by somebody
 * who could already read that mailbox. The audit row records which account
 * actually consumed it, which is the fact worth having later.
 */
export async function acceptInvite(
  db: PrismaClient,
  token: string,
  userId: string,
): Promise<{ tenantId: string; tenantSlug: string; role: Role }> {
  const preview = await previewInvite(db, token);
  if (!preview) throw new InviteNotUsableError();

  const existing = await db.tenantMembership.findFirst({
    where: { tenantId: preview.tenantId, userId },
    select: { id: true, role: true, status: true },
  });

  const rank = (r: Role) => INVITABLE_ROLES.indexOf(r);

  if (existing) {
    // Never demote. An invite is an offer to join; using one to quietly reduce
    // somebody's access would be a privilege change decided by whoever forwarded
    // a link.
    const keepHigher =
      existing.role === 'OWNER' || rank(existing.role) < rank(preview.role)
        ? existing.role
        : preview.role;

    await db.tenantMembership.update({
      where: { id: existing.id },
      data: { role: keepHigher, status: 'ACTIVE', acceptedAt: new Date(), deactivatedAt: null },
    });
  } else {
    await db.tenantMembership.create({
      data: {
        tenantId: preview.tenantId,
        userId,
        role: preview.role,
        status: 'ACTIVE',
        invitedById: null,
        acceptedAt: new Date(),
      },
    });
  }

  // Marked spent by the same predicate that found it, so two simultaneous
  // clicks cannot both consume it: the second updates zero rows.
  const consumed = await db.invite.updateMany({
    where: { id: preview.inviteId, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date() },
  });
  if (consumed.count === 0) throw new InviteNotUsableError();

  await appendAuditEntry(db, {
    tenantId: preview.tenantId,
    // The invitee, not the inviter. "Who joined" is the question this answers.
    actorUserId: userId,
    entity: 'Invite',
    entityId: preview.inviteId,
    action: AUDIT_ACTIONS.INVITE_ACCEPTED,
    details: `${preview.email} accepted an invite as ${preview.role}`,
    detailsJson: {
      category: 'access',
      summary: 'Invite accepted',
      after: { userId, role: preview.role, invitedEmail: preview.email },
    },
  });

  return { tenantId: preview.tenantId, tenantSlug: preview.tenantSlug, role: preview.role };
}
