'use server';

import type { Role } from '@prisma/client';
import { revalidatePath } from 'next/cache';

import { createInvite, revokeInvite, INVITABLE_ROLES } from '@/app-layer/usecases/invites';
import { changeMemberRole, setMemberSuspended } from '@/app-layer/usecases/staff';
import { sendMail } from '@/lib/email/mailer';
import { env } from '@/env';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * Staff mutations.
 *
 * ═══ THE ACTOR'S OWN AUTHORITY IS RESOLVED HERE, NOT TRUSTED ═══
 *
 * `requireTenantAction` returns the context it verified, including the
 * permissions derived from the membership matching THIS club. `canManageOwners`
 * is read from that, never from the form and never from the token — a hidden
 * field claiming owner rights is exactly the shape this whole design refuses.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

const ROLES: readonly Role[] = ['OWNER', 'MANAGER', 'COACH', 'STAFF', 'PLAYER'];

function mapError(err: unknown): ActionResult {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'LastOwnerError':
      return { ok: false, error: 'LAST_OWNER' };
    case 'CannotChangeOwnRoleError':
      return { ok: false, error: 'OWN_ROLE' };
    case 'OwnerManagementRequiredError':
      return { ok: false, error: 'OWNER_MANAGEMENT_REQUIRED' };
    case 'StaffMemberNotFoundError':
      return { ok: false, error: 'NOT_FOUND' };
    default:
      throw err;
  }
}

export async function changeRoleAction(
  slug: string,
  membershipId: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');

  const role = String(form.get('role') ?? '');
  if (!ROLES.includes(role as Role)) return { ok: false, error: 'BAD_ROLE' };

  try {
    await runInTenantContext(ctx.tenantId, (db) =>
      changeMemberRole(
        db,
        ctx.tenantId,
        {
          userId: ctx.userId,
          // From the verified context, not the request.
          canManageOwners: ctx.permissions.includes('admin.owner_management'),
        },
        membershipId,
        role as Role,
      ),
    );
  } catch (err) {
    return mapError(err);
  }

  revalidatePath(`/t/${slug}/admin/staff`);
  return { ok: true };
}

export async function setSuspendedAction(
  slug: string,
  membershipId: string,
  suspended: boolean,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');

  try {
    await runInTenantContext(ctx.tenantId, (db) =>
      setMemberSuspended(
        db,
        ctx.tenantId,
        {
          userId: ctx.userId,
          canManageOwners: ctx.permissions.includes('admin.owner_management'),
        },
        membershipId,
        suspended,
      ),
    );
  } catch (err) {
    return mapError(err);
  }

  revalidatePath(`/t/${slug}/admin/staff`);
  return { ok: true };
}

export async function inviteStaffAction(
  slug: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');

  const email = String(form.get('email') ?? '').trim();
  const role = String(form.get('role') ?? '');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'BAD_EMAIL' };
  if (!INVITABLE_ROLES.includes(role as Role)) return { ok: false, error: 'BAD_ROLE' };

  let token: string;
  try {
    const invite = await runInTenantContext(ctx.tenantId, (db) =>
      createInvite(db, ctx.tenantId, ctx.userId, { email, role: role as Role }),
    );
    token = invite.token;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AlreadyInvitedError') return { ok: false, error: 'ALREADY_INVITED' };
    if (name === 'RoleNotInvitableError') return { ok: false, error: 'BAD_ROLE' };
    throw err;
  }

  // ═══ SENT AFTER THE ROW COMMITS, AND FAILURE IS REPORTED ═══
  //
  // The token exists exactly once, in memory, right here — it is stored only
  // as a keyed hash. So if delivery fails there is no way to resend this one,
  // and the honest answer is to say so and let the admin revoke and retry
  // rather than to leave a row nobody can act on.
  const link = `${env.NEXTAUTH_URL}/invite/${token}`;
  try {
    await sendMail({
      to: email,
      subject: `You have been invited to join a club on playerz.bg`,
      text: `You have been invited to help run a club on playerz.bg.\n\nOpen this link to accept:\n${link}\n\nThe link works once and expires in 14 days.`,
    });
  } catch {
    return { ok: false, error: 'MAIL_FAILED' };
  }

  revalidatePath(`/t/${slug}/admin/staff`);
  return { ok: true };
}

export async function revokeInviteAction(slug: string, inviteId: string): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.staff_manage');

  try {
    await runInTenantContext(ctx.tenantId, (db) =>
      revokeInvite(db, ctx.tenantId, ctx.userId, inviteId),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'InviteNotUsableError') {
      return { ok: false, error: 'NOT_FOUND' };
    }
    throw err;
  }

  revalidatePath(`/t/${slug}/admin/staff`);
  return { ok: true };
}
