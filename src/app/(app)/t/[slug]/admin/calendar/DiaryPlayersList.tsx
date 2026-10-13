'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption } from '@/components/ui/typography';

import { markPlayerNoShowAction } from './actions';
import type { DayBooking, DiaryPlayer } from './DayGrid';

/**
 * The players on a booking, as the diary lists them (#358, #376, #513): each
 * player added to it or accepted through open play («през Игри»). A player who
 * joined through open play is on the booking after the club's cutoff, so staff
 * mark them as not having come one by one (`markPlayerNoShow`).
 *
 * One list for both of the diary's sheets: an online booking's
 * (DiaryPlayersSheet, which names the booker first) and a desk booking's
 * detail (DeskBookingDetails, whose header is the customer already).
 */
export function DiaryPlayersList({
  slug,
  booking: b,
  booker = null,
  onChanged,
}: {
  slug: string;
  booking: Pick<DayBooking, 'id' | 'startLabel' | 'endLabel' | 'players'>;
  /** The booker's name, as the list's first row; null leaves the row out. */
  booker?: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations('admin.calendar.players');
  const tNoShow = useTranslations('admin.calendar.noShow');
  const [target, setTarget] = useState<DiaryPlayer | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <>
      {refusal ? (
        <InlineNotice variant="error">{tNoShow(`error.${refusal}` as never)}</InlineNotice>
      ) : null}
      <ul className="divide-border-subtle divide-y">
        {booker !== null ? (
          <li className="flex min-h-12 items-center gap-2 py-2">
            <span className="text-content-default min-w-0 flex-1 truncate text-sm">{booker}</span>
            <Caption className="shrink-0">{t('booker')}</Caption>
          </li>
        ) : null}
        {b.players.map((p) => (
          <li key={p.id} className="flex min-h-12 items-center gap-2 py-2" data-diary-player>
            <span className="text-content-default min-w-0 flex-1 truncate text-sm">{p.name}</span>
            {p.viaOpenPlay ? (
              <StatusBadge variant="info" icon={null} className="shrink-0">
                {t('viaOpenPlay')}
              </StatusBadge>
            ) : null}
            {p.noShow ? (
              <StatusBadge variant="warning" icon={null} className="shrink-0">
                {t('noShow')}
              </StatusBadge>
            ) : p.canMarkNoShow ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0"
                aria-label={t('markLabel', { name: p.name })}
                onClick={() => {
                  setRefusal(null);
                  setTarget(p);
                  setConfirmOpen(true);
                }}
                data-diary-player-no-show
              >
                {t('mark')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {target ? (
        <ConfirmDialog
          showModal={confirmOpen}
          setShowModal={setConfirmOpen}
          tone="warning"
          title={t('confirmTitle', { name: target.name })}
          description={t('confirmBody', { start: b.startLabel, end: b.endLabel })}
          confirmLabel={t('mark')}
          onConfirm={async () => {
            const result = await markPlayerNoShowAction(slug, b.id, target.id);
            if (result.ok) onChanged();
            else setRefusal(result.error);
          }}
        />
      ) : null}
    </>
  );
}
