'use client';

import { startTransition, useActionState, useId, useMemo, useOptimistic, useState } from 'react';
import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns, DataTable } from '@/components/ui/table/data-table';
import { Heading } from '@/components/ui/typography';

import { inviteStaffAction, revokeInviteAction, setSuspendedAction } from './actions';
import { DEFAULT_INVITE_ROLE, INVITE_ROLES } from './roles';

/**
 * The member sheet and the confirm load when first opened, not with the route
 * — the trade the courts and pricing boards made (T23, T24).
 */
const StaffSheet = dynamic(() => import('./StaffSheet'));
const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

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
 * An invite names MANAGER or STAFF, and starts on STAFF (#278, ./roles.ts):
 * never OWNER, which is accepted by whoever holds the link; not COACH until
 * #269, because a coach is its own kind of account that nothing creates yet;
 * not PLAYER, because players join by booking.
 *
 * ═══ ON THE PRIMITIVES (T25) ═══
 *
 * The members are the vendored DataTable — a table from md, keyboard-operable
 * cards below it — and a member's name opens them in a Sheet with the role as a
 * RadioGroup. The two native selects (role, invite role) are RadioGroups, the
 * two `window.confirm`s ConfirmDialogs, and the `role=alert` paragraphs
 * InlineNotices.
 *
 * ═══ SUSPEND AND REVOKE ARE OPTIMISTIC ═══
 *
 * The status flips, or the invite leaves the list, the moment the owner
 * confirms (`useOptimistic`), instead of after the action's round trip AND the
 * revalidated page it carries back. That payload is the truth and lands in the
 * same transition. If the action refuses or throws, the transition ends with
 * the props unchanged, the override falls away by itself (that IS the
 * rollback), and a notice says what did not happen — a status that silently
 * snapped back would read as a click that missed.
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

/** Why a member's row has no controls, or null when it has them. */
export type LockReason = 'self' | 'lastOwner' | 'ownerManagement' | null;

/**
 * The name is a real button and the table has no `onRowClick`: a clickable
 * `<tr>` has no keyboard path. (The phone cards' `role="button"` inside
 * `role="list"`, which axe refused at 393 px, is fixed upstream
 * (#3129 there).) 44 px on a coarse pointer.
 */
const NAME_BUTTON =
  'text-content-emphasis focus-visible:ring-ring rounded-sm text-left font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11';

const NO_STATUS_OVERRIDES: Readonly<Record<string, string>> = {};

type SuspendFailure = { name: string; error: string | null } | null;

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

  // The member being looked at, and the one being asked about, outlive their
  // overlays' open flags so a closing sheet or dialog still names them.
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [asking, setAsking] = useState<StaffRow | null>(null);
  const [confirming, setConfirming] = useState(false);

  const [statusOverrides, setOptimisticStatus] = useOptimistic(
    NO_STATUS_OVERRIDES,
    (s, next: { id: string; status: string }) => ({ ...s, [next.id]: next.status }),
  );
  const [suspendFailed, setSuspended, suspendPending] = useActionState(
    async (_prev: SuspendFailure, input: { member: StaffRow; suspend: boolean }) => {
      const { member, suspend } = input;
      setOptimisticStatus({ id: member.membershipId, status: suspend ? 'SUSPENDED' : 'ACTIVE' });
      const name = member.name ?? member.email;
      try {
        const result = await setSuspendedAction(slug, member.membershipId, suspend);
        return result.ok ? null : { name, error: result.error };
      } catch {
        return { name, error: null };
      }
    },
    null,
  );

  const rows = useMemo(
    () =>
      members.map((m) =>
        statusOverrides[m.membershipId] ? { ...m, status: statusOverrides[m.membershipId]! } : m,
      ),
    [members, statusOverrides],
  );

  const lockOf = (m: StaffRow): LockReason => {
    if (m.userId === viewerUserId) return 'self';
    if (m.role === 'OWNER' && m.status === 'ACTIVE' && activeOwnerCount <= 1) return 'lastOwner';
    if (m.role === 'OWNER' && !canManageOwners) return 'ownerManagement';
    return null;
  };

  const open = (id: string) => {
    setOpenId(id);
    setSheetOpen(true);
  };

  const columns = createColumns<StaffRow>([
    {
      id: 'name',
      header: t('field.name'),
      cell: ({ row }) => {
        const m = row.original;
        const label = m.name ?? m.email;
        return (
          <span className="gap-tight inline-flex flex-wrap items-center justify-end md:justify-start">
            {/* The name is the row's control in both renderings — see
                NAME_BUTTON. */}
            <button type="button" className={NAME_BUTTON} onClick={() => open(m.membershipId)}>
              {label}
            </button>
            {m.userId === viewerUserId && <StatusBadge variant="neutral">{t('you')}</StatusBadge>}
          </span>
        );
      },
    },
    {
      id: 'email',
      header: t('field.email'),
      cell: ({ row }) => <span className="text-content-muted">{row.original.email}</span>,
    },
    {
      id: 'role',
      header: t('field.role'),
      cell: ({ row }) => (
        <StatusBadge variant={row.original.role === 'OWNER' ? 'info' : 'neutral'}>
          {t(`role.${row.original.role}` as never)}
        </StatusBadge>
      ),
    },
    {
      id: 'status',
      header: t('field.status'),
      cell: ({ row }) => (
        <StatusBadge
          variant={row.original.status === 'ACTIVE' ? 'success' : 'warning'}
          data-member-status={row.original.status}
        >
          {t(`status.${row.original.status}` as never)}
        </StatusBadge>
      ),
    },
  ]);

  const current = openId ? rows.find((m) => m.membershipId === openId) : undefined;

  return (
    <div className="gap-section grid">
      <InviteSection slug={slug} invites={invites} />

      <section className="gap-compact grid">
        <Heading level={2}>{t('membersHeading')}</Heading>

        {suspendFailed !== null && !suspendPending && (
          <InlineNotice variant="error" title={t('suspend.failed', { name: suspendFailed.name })}>
            {suspendFailed.error ? t(`error.${suspendFailed.error}` as never) : null}
          </InlineNotice>
        )}

        {/* data-perf-ready: the perf harness's READY marker (docs/perf/README.md),
            on the DataTable's wrapper so it is there in both renderings. */}
        <div data-perf-ready className="min-w-0">
          <DataTable<StaffRow>
            data={rows}
            columns={columns}
            getRowId={(m) => m.membershipId}
            // Cards below md, explicitly: four columns do not fit 393 px.
            mobileFallback="card"
            selectionEnabled={false}
            data-testid="staff-table"
          />
        </div>
      </section>

      {openId !== null && current && (
        <StaffSheet
          slug={slug}
          member={current}
          lock={lockOf(current)}
          canManageOwners={canManageOwners}
          open={sheetOpen}
          setOpen={setSheetOpen}
          onSuspend={(suspend) => {
            setSheetOpen(false);
            if (suspend) {
              // Asked first: a suspended member loses access on their next
              // request. Reinstating gives access back, and is not asked.
              setAsking(current);
              setConfirming(true);
            } else {
              startTransition(() => setSuspended({ member: current, suspend: false }));
            }
          }}
        />
      )}

      {/* Mounted from the first ask on, never before: a dynamic component
          rendered at all is fetched at once. Kept mounted after, so closing
          plays the dialog's exit rather than vanishing. */}
      {asking && (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="warning"
          title={t('suspend.title', { name: asking.name ?? asking.email })}
          description={t('suspend.confirm')}
          confirmLabel={t('action.suspend')}
          cancelLabel={t('action.cancel')}
          // Returns nothing, so the dialog closes at once and the status flips
          // under it — awaiting the action here would hold the dialog open for
          // the round trip and spend the optimistic update on a spinner.
          onConfirm={() => startTransition(() => setSuspended({ member: asking, suspend: true }))}
        />
      )}
    </div>
  );
}

const NONE_REVOKING: ReadonlySet<string> = new Set();

/**
 * Inviting somebody, and the invites still waiting.
 *
 * Only OPEN invites are listed. An accepted one is answered by the member now
 * in the list below; a revoked or expired one is answered by its absence. Both
 * remain in `audit_entry`, which nothing deletes.
 */
function InviteSection({ slug, invites }: { slug: string; invites: readonly OpenInviteRow[] }) {
  const t = useTranslations('admin.staff');
  const format = useFormatter();
  const ids = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [state, formAction, pending] = useActionState(inviteStaffAction.bind(null, slug), null);
  const [asking, setAsking] = useState<OpenInviteRow | null>(null);
  const [confirming, setConfirming] = useState(false);

  // ═══ ONE RESULT, HANDLED ONCE (#328) ═══
  //
  // `useActionState` never resets `state`, so the first success stays `ok`
  // for the life of the page. Closing the form on "state is ok" closed it
  // again on every later open: a second invite needed a reload. So a result is
  // acted on when it is NEW (a fresh object per submission), and the form
  // closes on that render only. The same bookkeeping keeps an old error from
  // greeting the next opening of the form.
  const [handled, setHandled] = useState(state);
  const [shownFrom, setShownFrom] = useState(state);
  if (state !== handled) {
    setHandled(state);
    // A successful send closes the form; the new invite arrives via revalidation.
    if (state?.ok) setFormOpen(false);
  }
  const error = state && !state.ok && state !== shownFrom ? state.error : null;
  const openForm = () => {
    setShownFrom(state);
    setFormOpen(true);
  };

  const [revoking, markRevoking] = useOptimistic(NONE_REVOKING, (s, id: string) =>
    new Set(s).add(id),
  );
  const [revokeFailedFor, revoke, revokePending] = useActionState(
    async (_prev: string | null, invite: OpenInviteRow): Promise<string | null> => {
      markRevoking(invite.id);
      try {
        const result = await revokeInviteAction(slug, invite.id);
        return result.ok ? null : invite.email;
      } catch {
        return invite.email;
      }
    },
    null,
  );
  const visible = revoking.size === 0 ? invites : invites.filter((i) => !revoking.has(i.id));

  return (
    <section className="gap-compact grid">
      <div className="gap-compact flex flex-wrap items-center">
        <Heading level={2}>{t('inviteHeading')}</Heading>
        {!formOpen && (
          <Button type="button" onClick={openForm}>
            {t('action.invite')}
          </Button>
        )}
      </div>

      {formOpen && (
        <Card density="compact" elevation="flat" className="bg-bg-default">
          <form action={formAction} className="gap-compact grid">
            <div className="sm:max-w-sm">
              <FormField label={t('field.email')}>
                <Input id={`${ids}-email`} name="email" type="email" required autoComplete="off" />
              </FormField>
            </div>

            <fieldset className="gap-tight grid">
              <legend id={`${ids}-role`} className="text-content-default mb-1 text-sm font-medium">
                {t('field.role')}
              </legend>
              <RadioGroup
                name="role"
                defaultValue={DEFAULT_INVITE_ROLE}
                aria-labelledby={`${ids}-role`}
                className="flex flex-wrap gap-x-6 gap-y-2"
              >
                {INVITE_ROLES.map((r) => (
                  <div key={r} className="flex items-center gap-1.5">
                    <RadioGroupItem value={r} id={`${ids}-role-${r}`} />
                    <Label htmlFor={`${ids}-role-${r}`}>{t(`role.${r}`)}</Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>

            {/* OWNER is not offered, and the reason is worth saying: an invite
                is accepted by whoever holds the link. */}
            <p className="text-content-muted text-sm">{t('inviteNote')}</p>

            <div className="gap-tight flex flex-wrap">
              <Button type="submit" disabled={pending}>
                {t('action.send')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>
                {t('action.cancel')}
              </Button>
            </div>

            {error && !pending && (
              <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>
            )}
          </form>
        </Card>
      )}

      {revokeFailedFor !== null && !revokePending && (
        <InlineNotice variant="error">
          {t('invite.revokeFailed', { email: revokeFailedFor })}
        </InlineNotice>
      )}

      {visible.length > 0 && (
        <ul className="gap-tight grid">
          {visible.map((i) => (
            <Card
              as="li"
              key={i.id}
              elevation="flat"
              density="compact"
              className="bg-bg-default gap-compact flex flex-wrap items-center justify-between"
              data-invite-id={i.id}
            >
              <div className="min-w-0">
                <span className="font-medium break-all">{i.email}</span>
                <p className="text-content-muted text-sm">
                  {t(`role.${i.role}` as never)} ·{' '}
                  {t('invite.expires', {
                    date: format.dateTime(new Date(i.expiresAt), { dateStyle: 'medium' }),
                  })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAsking(i);
                  setConfirming(true);
                }}
              >
                {t('action.revoke')}
              </Button>
            </Card>
          ))}
        </ul>
      )}

      {asking && (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="danger"
          title={t('invite.revokeTitle')}
          description={t('invite.revokeConfirm', { email: asking.email })}
          confirmLabel={t('action.revoke')}
          cancelLabel={t('action.cancel')}
          onConfirm={() => startTransition(() => revoke(asking))}
        />
      )}
    </section>
  );
}
