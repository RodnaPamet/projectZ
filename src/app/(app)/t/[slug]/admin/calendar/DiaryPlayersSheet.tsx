'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';

import type { DayBooking } from './DayGrid';
import { DiaryPlayersList } from './DiaryPlayersList';

/**
 * Who plays an online booking (#358, #376): the booker, and each player added
 * to it or accepted through open play («през Игри»), in DiaryPlayersList. The
 * booking's own «Никой не дойде» stays the booker's, as before.
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
        <DiaryPlayersList slug={slug} booking={b} booker={b.who} onChanged={onChanged} />
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
    </Sheet>
  );
}
