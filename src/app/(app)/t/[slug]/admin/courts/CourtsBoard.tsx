'use client';

import { startTransition, useActionState, useOptimistic, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';

import { archiveCourtAction } from './actions';
import { CourtForm, type CourtFormValues } from './CourtForm';

/**
 * The courts screen's interactive half.
 *
 * The page stays a server component — it resolves the tenant, checks the
 * permission and runs the query inside `runInTenantContext`. Only the bits that
 * need state live here, and they receive plain serialisable data.
 *
 * Money is formatted with next-intl's `useFormatter`, not `'€' + toFixed(2)`:
 * Bulgarian writes `24,00 €`, with the symbol trailing and a comma decimal.
 */

export interface CourtRow extends CourtFormValues {
  id: string;
  status: string;
  venueName: string;
  upcomingBookings: number;
}

export function CourtsBoard({
  slug,
  courts,
  venues,
}: {
  slug: string;
  courts: readonly CourtRow[];
  venues: ReadonlyArray<{ id: string; name: string }>;
}) {
  const t = useTranslations('admin.courts');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="gap-default grid">
      <div>
        {adding ? (
          <Card density="compact" elevation="flat" className="bg-bg-default">
            <CourtForm slug={slug} venues={venues} onDone={() => setAdding(false)} />
          </Card>
        ) : (
          // A club with no venue has nowhere to put a court, and a form whose
          // only select is empty is a worse explanation than not offering it.
          <Button type="button" onClick={() => setAdding(true)} disabled={venues.length === 0}>
            {t('action.add')}
          </Button>
        )}
        {venues.length === 0 && <p className="text-content-muted mt-2 text-sm">{t('needVenue')}</p>}
      </div>

      {courts.length === 0 ? (
        <div data-perf-ready>
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        </div>
      ) : (
        // data-perf-ready: the perf harness's READY marker (docs/perf/README.md).
        // Its staff-write journey opens `ul[data-perf-ready] > li:first-child
        // button` and checks it reads "Edit", then reads the name from that
        // card's h2 — so each card stays an <li>, Edit stays its first button,
        // and the name stays its h2.
        <ul data-perf-ready className="gap-compact grid sm:grid-cols-2 lg:grid-cols-3">
          {courts.map((court) => (
            <Card
              as="li"
              key={court.id}
              elevation="flat"
              density="compact"
              className="bg-bg-default"
            >
              {editingId === court.id ? (
                <CourtForm slug={slug} court={court} onDone={() => setEditingId(null)} />
              ) : (
                <CourtCard slug={slug} court={court} onEdit={() => setEditingId(court.id)} />
              )}
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One court, and its archive / reopen.
 *
 * ═══ OPTIMISTIC, AND HONEST ABOUT FAILING ═══
 *
 * The badge and the button flip the moment the owner confirms
 * (`useOptimistic`), instead of after the action's round trip AND the
 * revalidated page payload it carries back. The action still revalidates the
 * path: the payload it returns is the truth, and it lands in the same
 * transition, so the optimistic status is replaced by the real one without a
 * flicker.
 *
 * If the action refuses or throws, the transition ends with the props
 * unchanged, the optimistic status falls back to the real one by itself (that
 * IS the rollback), and the card says the change did not happen. A status that
 * silently snapped back would read as a click that missed.
 *
 * ═══ THE CONFIRMATION SAYS WHAT ARCHIVING DOES NOT DO ═══
 *
 * It changes availability for everyone, but the bookings already on the court
 * survive and stay cancellable through the ordinary path with its ordinary
 * refund policy. An owner archiving a court mid-season would otherwise expect
 * the diary to clear. Asked only when there ARE upcoming bookings — a warning
 * on every archive is a warning nobody reads. A dialog, not `window.confirm`:
 * the browser's own box ignores the theme and the locale's button labels.
 */
function CourtCard({ slug, court, onEdit }: { slug: string; court: CourtRow; onEdit: () => void }) {
  const t = useTranslations('admin.courts');
  const format = useFormatter();
  const [confirming, setConfirming] = useState(false);

  const [status, setOptimisticStatus] = useOptimistic(court.status);
  const [failed, setArchived, pending] = useActionState(
    async (_failed: boolean, reopen: boolean): Promise<boolean> => {
      setOptimisticStatus(reopen ? 'ACTIVE' : 'CLOSED');
      try {
        const result = await archiveCourtAction(slug, court.id, reopen);
        return !result.ok;
      } catch {
        return true;
      }
    },
    false,
  );

  const archived = status === 'CLOSED';
  const flip = (reopen: boolean) => startTransition(() => setArchived(reopen));

  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR' });

  return (
    <>
      <div className="gap-compact flex items-start justify-between">
        <div className="min-w-0">
          <Heading level={2} className="text-base font-medium">
            {court.name}
          </Heading>
          <p className="text-content-muted text-sm">{court.venueName}</p>
        </div>
        <StatusBadge
          variant={status === 'ACTIVE' ? 'success' : 'neutral'}
          className="shrink-0"
          data-court-status={status}
        >
          {t(`status.${status}` as never)}
        </StatusBadge>
      </div>

      <dl className="text-content-muted mt-compact grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt>{t('field.setting')}</dt>
        <dd className="text-content-default">
          {court.isIndoor ? t('setting.indoor') : t('setting.outdoor')}
        </dd>
        <dt>{t('field.capacity')}</dt>
        <dd className="text-content-default">{t('capacity', { count: court.capacity })}</dd>
        <dt>{t('field.basePrice')}</dt>
        <dd className="text-content-default">{money(court.basePriceCents)}</dd>
      </dl>

      <div className="mt-compact gap-tight flex">
        <Button type="button" variant="ghost" onClick={onEdit}>
          {t('action.edit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (archived) flip(true);
            else if (court.upcomingBookings > 0) setConfirming(true);
            else flip(false);
          }}
        >
          {archived ? t('action.reopen') : t('action.archive')}
        </Button>
      </div>

      {failed && !pending && (
        <InlineNotice variant="error" className="mt-compact">
          {t('archive.failed')}
        </InlineNotice>
      )}

      <ConfirmDialog
        showModal={confirming}
        setShowModal={setConfirming}
        tone="warning"
        title={t('archive.title')}
        description={t('archive.confirm', { count: court.upcomingBookings })}
        confirmLabel={t('action.archive')}
        cancelLabel={t('action.cancel')}
        // Returns nothing, so the dialog closes at once and the card flips
        // under it — awaiting the action here would hold the dialog open for
        // the round trip and spend the optimistic update on a spinner.
        onConfirm={() => flip(false)}
      />
    </>
  );
}
