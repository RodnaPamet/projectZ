'use client';

import { useActionState, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';

import {
  changeRoleAction,
  inviteStaffAction,
  revokeInviteAction,
  setSuspendedAction,
} from './actions';

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
 * ═══ INVITES ═══
 *
 * They work now (#199): a mailer, an acceptance page at `/invite/[token]`, and
 * a single-use expiring token stored only as a keyed hash.
 *
 * An invite cannot name OWNER. It is accepted by whoever holds the link, and
 * ownership carries the two-party protection the staff list enforces above —
 * one forwarded email must not be able to route around it.
 *
 * Promoting an existing member still works and is often the better route,
 * which is why PLAYER rows remain in the list.
 */

export interface StaffRow {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: string;
  status: string;
}

export interface OpenInviteRow {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

/** OWNER is absent on purpose — see the docblock. */
const INVITE_ROLES = ['MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const;

const ROLES = ['OWNER', 'MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const;

export function StaffBoard({
  slug,
  members,
  invites,
  viewerUserId,
  canManageOwners,
  activeOwnerCount,
}: {
  slug: string;
  members: readonly StaffRow[];
  invites: readonly OpenInviteRow[];
  viewerUserId: string;
  canManageOwners: boolean;
  activeOwnerCount: number;
}) {
  const t = useTranslations('admin.staff');

  return (
    <>
      <InviteSection slug={slug} invites={invites} />

      <h2 className="mt-8 mb-2 font-medium">{t('membersHeading')}</h2>
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

/**
 * Inviting somebody, and the invites still waiting.
 *
 * Only OPEN invites are listed. An accepted one is answered by the member now
 * in the list above; a revoked or expired one is answered by its absence. Both
 * remain in `audit_entry`, which nothing deletes.
 */
function InviteSection({ slug, invites }: { slug: string; invites: readonly OpenInviteRow[] }) {
  const t = useTranslations('admin.staff');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(inviteStaffAction.bind(null, slug), null);

  // A successful send closes the form; the new invite arrives via revalidation.
  if (state?.ok && open) setOpen(false);

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">{t('inviteHeading')}</h2>
        {!open && (
          <Button type="button" onClick={() => setOpen(true)}>
            {t('action.invite')}
          </Button>
        )}
      </div>

      {open && (
        <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">{t('field.email')}</Label>
            <Input id="invite-email" name="email" type="email" required autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">{t('field.role')}</Label>
            <select
              id="invite-role"
              name="role"
              defaultValue="COACH"
              className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
            >
              {INVITE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending}>
            {t('action.send')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t('action.cancel')}
          </Button>
          {/* OWNER is not offered, and the reason is worth saying: an invite is
              accepted by whoever holds the link. */}
          <p className="text-content-muted w-full text-sm">{t('inviteNote')}</p>
          {state && !state.ok && (
            <p role="alert" className="text-content-error w-full text-sm">
              {t(`error.${state.error}`)}
            </p>
          )}
        </form>
      )}

      {invites.length > 0 && (
        <ul className="mt-3 grid gap-2">
          {invites.map((i) => (
            <li
              key={i.id}
              className="border-border-subtle flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <span className="font-medium">{i.email}</span>
                <p className="text-content-muted text-sm">
                  {t(`role.${i.role}`)} ·{' '}
                  {t('invite.expires', {
                    date: format.dateTime(new Date(i.expiresAt), { dateStyle: 'medium' }),
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  if (window.confirm(t('invite.revokeConfirm', { email: i.email }))) {
                    await revokeInviteAction(slug, i.id);
                  }
                }}
              >
                {t('action.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
