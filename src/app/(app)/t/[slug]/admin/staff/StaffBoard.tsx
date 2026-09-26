'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';

import { changeRoleAction, setSuspendedAction } from './actions';

/**
 * Who runs the club.
 *
 * ═══ THE CONTROLS THAT ARE ABSENT ARE THE POINT ═══
 *
 * A member cannot change their own role — there is no control on their own
 * row, and the action refuses it besides. The last active owner has no demote
 * and no suspend, for the same reason: a club with no owner cannot change
 * roles, manage payouts, or recover without platform support.
 *
 * Hiding those is a courtesy. Every one of them is enforced again in the use
 * case, against a counted query rather than this list — which is capped, and
 * so cannot answer "is this the last owner?" for a club of 200.
 *
 * ═══ NO INVITE CONTROL, DELIBERATELY ═══
 *
 * Invites cannot work yet: there is no acceptance route and no mailer (#199).
 * A button that wrote rows nobody can accept, with no way to deliver the
 * token, would be worse than its absence. Promoting an existing member is how
 * a club gains staff until that lands, which is why PLAYER rows are listed.
 */

export interface StaffRow {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: string;
  status: string;
}

const ROLES = ['OWNER', 'MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const;

export function StaffBoard({
  slug,
  members,
  viewerUserId,
  canManageOwners,
  activeOwnerCount,
}: {
  slug: string;
  members: readonly StaffRow[];
  viewerUserId: string;
  canManageOwners: boolean;
  activeOwnerCount: number;
}) {
  const t = useTranslations('admin.staff');

  return (
    <>
      <p className="text-content-muted mb-4 text-sm">{t('inviteUnavailable')}</p>

      <ul className="grid gap-2">
        {members.map((m) => {
          const isSelf = m.userId === viewerUserId;
          const isLastOwner = m.role === 'OWNER' && m.status === 'ACTIVE' && activeOwnerCount <= 1;
          const ownerLocked = m.role === 'OWNER' && !canManageOwners;
          const locked = isSelf || isLastOwner || ownerLocked;

          return (
            <li key={m.membershipId} className="border-border-subtle rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span className="font-medium">{m.name ?? m.email}</span>
                  {m.name && <p className="text-content-muted text-sm">{m.email}</p>}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <StatusBadge variant={m.role === 'OWNER' ? 'info' : 'neutral'}>
                      {t(`role.${m.role}`)}
                    </StatusBadge>
                    {m.status !== 'ACTIVE' && (
                      <StatusBadge variant="warning">{t(`status.${m.status}`)}</StatusBadge>
                    )}
                    {isSelf && <StatusBadge variant="neutral">{t('you')}</StatusBadge>}
                  </div>
                </div>

                {!locked && (
                  <SuspendButton
                    slug={slug}
                    membershipId={m.membershipId}
                    suspended={m.status !== 'ACTIVE'}
                  />
                )}
              </div>

              {locked ? (
                <p className="text-content-muted mt-2 text-sm">
                  {isSelf
                    ? t('locked.self')
                    : isLastOwner
                      ? t('locked.lastOwner')
                      : t('locked.ownerManagement')}
                </p>
              ) : (
                <RoleForm slug={slug} member={m} canManageOwners={canManageOwners} />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function RoleForm({
  slug,
  member,
  canManageOwners,
}: {
  slug: string;
  member: StaffRow;
  canManageOwners: boolean;
}) {
  const t = useTranslations('admin.staff');
  const [state, formAction, pending] = useActionState(
    changeRoleAction.bind(null, slug, member.membershipId),
    null,
  );

  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-end gap-2">
      <div className="grid gap-1.5">
        <label className="text-content-muted text-sm" htmlFor={`role-${member.membershipId}`}>
          {t('field.role')}
        </label>
        <select
          id={`role-${member.membershipId}`}
          name="role"
          defaultValue={member.role}
          className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
        >
          {ROLES.map((r) => (
            // Granting ownership needs admin.owner_management. Disabled rather
            // than hidden, so a manager can see the ceiling exists.
            <option key={r} value={r} disabled={r === 'OWNER' && !canManageOwners}>
              {t(`role.${r}`)}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" disabled={pending}>
        {t('action.save')}
      </Button>

      {state && !state.ok && (
        <p role="alert" className="text-content-error w-full text-sm">
          {t(`error.${state.error}`)}
        </p>
      )}
    </form>
  );
}

function SuspendButton({
  slug,
  membershipId,
  suspended,
}: {
  slug: string;
  membershipId: string;
  suspended: boolean;
}) {
  const t = useTranslations('admin.staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="text-right">
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          if (!suspended && !window.confirm(t('suspend.confirm'))) return;
          setBusy(true);
          setError(null);
          try {
            const r = await setSuspendedAction(slug, membershipId, !suspended);
            if (!r.ok) setError(r.error);
          } finally {
            setBusy(false);
          }
        }}
      >
        {suspended ? t('action.reinstate') : t('action.suspend')}
      </Button>
      {error && (
        <p role="alert" className="text-content-error text-sm">
          {t(`error.${error}`)}
        </p>
      )}
    </div>
  );
}
