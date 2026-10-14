'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

import type { DayBooking } from './DayGrid';
import { DiaryPlayersList } from './DiaryPlayersList';

/**
 * Who plays an online booking (#358, #376): the booker, and each player added
 * to it or accepted through open play («през Игри»), in DiaryPlayersList. The
 * booking's own «Никой не дойде» stays the booker's, as before. While the
 * booking is still ahead, the booker's row has their number to call (#500),
 * and that alone is reason enough to open this sheet.
 *
 * A LESSON (#549) says who teaches it, and while it is still ahead the desk
 * can cancel it here: the same cancellation the club's staff can always make
 * (`POST /t/{slug}/bookings/{id}/cancel`), so the court is released and
 * everyone on the lesson is told the club cancelled. It asks first, in place:
 * a second step in this sheet, not a dialog over it.
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
  const [confirming, setConfirming] = useState(false);
  const cancel = useV1Mutation<string, unknown>({ url: (id) => V1.cancelBooking(slug, id) });

  async function cancelLesson() {
    try {
      await cancel.trigger(b.id);
      onChanged();
      onClose();
    } catch {
      // Said below, from `cancel.error`; the sheet stays for another try.
    }
  }

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
        {b.lessonCoach ? (
          <p className="text-content-default text-sm" data-diary-lesson>
            {t('lesson', { coach: b.lessonCoach })}
          </p>
        ) : null}
        <DiaryPlayersList
          slug={slug}
          booking={b}
          booker={b.who}
          bookerPhone={b.bookerPhone}
          onChanged={onChanged}
        />
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
        {b.lessonCancellable ? (
          confirming ? (
            <div className="gap-compact grid" data-diary-lesson-confirm>
              <InlineNotice variant="warning" title={t('cancelLesson.title')}>
                {t('cancelLesson.description')}
              </InlineNotice>
              {cancel.error ? (
                <InlineNotice variant="error">{t('cancelLesson.failed')}</InlineNotice>
              ) : null}
              <div className="gap-tight flex flex-wrap">
                <Button
                  type="button"
                  variant="destructive"
                  loading={cancel.isMutating}
                  disabled={cancel.isMutating}
                  onClick={() => void cancelLesson()}
                  data-diary-lesson-cancel-yes
                >
                  {t('cancelLesson.yes')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cancel.isMutating}
                  onClick={() => setConfirming(false)}
                >
                  {t('cancelLesson.no')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              onClick={() => setConfirming(true)}
              data-diary-lesson-cancel
            >
              {t('cancelLesson.button')}
            </Button>
          )
        ) : null}
      </Sheet.Body>
    </Sheet>
  );
}
