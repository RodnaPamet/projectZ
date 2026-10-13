'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption } from '@/components/ui/typography';

import { markPlayerNoShowAction } from './actions';
import type { DayBooking, DiaryPlayer } from './DayGrid';

/**
 * Who plays an online booking (#358, #376): the booker, and each player added
 * to it or accepted through open play («през Игри»). A player who joined
 * through open play is on the booking after the club's cutoff, so staff mark
 * them as not having come one by one (`markPlayerNoShow`); the booking's own
 * «Никой не дойде» stays the booker's, as before.
 */
export default function DiaryPlayersSheet({
  slug,
  booking: b,
  onClose,
  onChanged,
  onMarkBookingNoShow,
}: {
  slug: string;
  booking: DayBooking;
  onClose: () => void;
  onChanged: () => void;
  onMarkBookingNoShow: () => void;
}) {
  const t = useTranslations('admin.calendar.players');
  const tNoShow = useTranslations('admin.calendar.noShow');
  const [target, setTarget] = useState<DiaryPlayer | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={b.who}
      size="sm"
    >
      <Sheet.Header
        title={b.who}
        description={t('when', { start: b.startLabel, end: b.endLabel, price: b.priceLabel })}
      />
      <Sheet.Body className="gap-section grid content-start" data-diary-players>
        {refusal ? (
          <InlineNotice variant="error">{tNoShow(`error.${refusal}` as never)}</InlineNotice>
        ) : null}
        <ul className="divide-border-subtle divide-y">
          <li className="flex min-h-12 items-center gap-2 py-2">
            <span className="text-content-default min-w-0 flex-1 truncate text-sm">{b.who}</span>
            <Caption className="shrink-0">{t('booker')}</Caption>
          </li>
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
        {b.canMarkNoShow ? (
          <Button
            type="button"
            variant="secondary"
            className="justify-self-start"
            onClick={onMarkBookingNoShow}
            data-diary-booking-no-show
          >
            {t('markBooking')}
          </Button>
        ) : null}
      </Sheet.Body>

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
    </Sheet>
  );
}
