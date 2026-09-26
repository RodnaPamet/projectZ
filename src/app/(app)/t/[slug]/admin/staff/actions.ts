'use server';

import type { Role } from '@prisma/client';
import { revalidatePath } from 'next/cache';

import { changeMemberRole, setMemberSuspended } from '@/app-layer/usecases/staff';
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
