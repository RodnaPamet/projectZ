'use client';

import { useActionState, useId, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { roleChangeKeepsKind } from '@/lib/auth/account-kind';
import { isRole } from '@/lib/permissions';

import { changeRoleAction } from './actions';
import { ROLES } from './roles';
import type { LockReason, StaffRow } from './StaffBoard';

/**
 * One member: their role, and suspend or reinstate.
 *
 * A locked member (yourself, the last active owner, an owner when you cannot
 * manage owners) opens to the reason and no controls — the same courtesy the
 * row used to show inline. The use case enforces each again.
 */
export default function StaffSheet({
  slug,
  member,
  lock,
  canManageOwners,
  open,
  setOpen,
  onSuspend,
}: {
  slug: string;
  member: StaffRow;
  lock: LockReason;
  canManageOwners: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** The board's optimistic flip: it closes this sheet, and asks before suspending. */
  onSuspend: (suspend: boolean) => void;
}) {
  const t = useTranslations('admin.staff');
  const title = member.name ?? member.email;
  const suspended = member.status !== 'ACTIVE';

  return (
    <Sheet open={open} onOpenChange={setOpen} title={title} size="sm">
      <Sheet.Header title={title} description={member.name ? member.email : undefined}>
        <span className="gap-tight mt-1 flex flex-wrap">
          <StatusBadge variant={member.role === 'OWNER' ? 'info' : 'neutral'}>
            {t(`role.${member.role}` as never)}
          </StatusBadge>
          <StatusBadge variant={suspended ? 'warning' : 'success'}>
            {t(`status.${member.status}` as never)}
          </StatusBadge>
        </span>
      </Sheet.Header>
      <Sheet.Body className="gap-section grid content-start">
        {lock ? (
          <p className="text-content-muted">{t(`locked.${lock}`)}</p>
        ) : (
          <>
            <RoleForm
              key={`${member.membershipId}:${member.role}`}
              slug={slug}
              member={member}
              canManageOwners={canManageOwners}
              onDone={() => setOpen(false)}
            />
            <div className="border-border-subtle pt-default border-t">
              <Button
                type="button"
                variant={suspended ? 'secondary' : 'destructive'}
                onClick={() => onSuspend(!suspended)}
              >
                {suspended ? t('action.reinstate') : t('action.suspend')}
              </Button>
            </div>
          </>
        )}
      </Sheet.Body>
    </Sheet>
  );
}

function RoleForm({
  slug,
  member,
  canManageOwners,
  onDone,
}: {
  slug: string;
  member: StaffRow;
  canManageOwners: boolean;
  onDone: () => void;
}) {
  const t = useTranslations('admin.staff');
  const ids = useId();
  const [state, formAction, pending] = useActionState(
    async (prev: Awaited<ReturnType<typeof changeRoleAction>> | null, form: FormData) => {
      const result = await changeRoleAction(slug, member.membershipId, prev, form);
      if (result.ok) onDone();
      return result;
    },
    null,
  );

  return (
    <form action={formAction} className="gap-compact grid">
      <fieldset className="gap-tight grid">
        <legend id={`${ids}-legend`} className="text-content-default mb-1 text-sm font-medium">
          {t('field.role')}
        </legend>
        <RadioGroup name="role" defaultValue={member.role} aria-labelledby={`${ids}-legend`}>
          {ROLES.map((r) => {
            // A role from another kind of account (#263): player, club and
            // coach are separate accounts, so a player is invited to become
            // staff rather than promoted, and the server refuses it anyway.
            const otherKind = isRole(member.role) && !roleChangeKeepsKind(member.role, r);
            // Granting ownership needs admin.owner_management. Disabled rather
            // than hidden, so a manager can see the ceiling exists.
            const disabled = otherKind || (r === 'OWNER' && !canManageOwners);
            return (
              <div key={r} className="flex items-center gap-1.5">
                <RadioGroupItem value={r} id={`${ids}-${r}`} disabled={disabled} />
                <Label htmlFor={`${ids}-${r}`} className={disabled ? 'text-content-muted' : ''}>
                  {otherKind ? `${t(`role.${r}`)} (${t('separateAccount')})` : t(`role.${r}`)}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      </fieldset>

      <div>
        <Button type="submit" disabled={pending}>
          {t('action.save')}
        </Button>
      </div>

      {state && !state.ok && !pending && (
        <InlineNotice variant="error">{t(`error.${state.error}` as never)}</InlineNotice>
      )}
    </form>
  );
}
