'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';

import { reviewBookingAction } from './actions';

/**
 * Rate the venue a completed booking was at.
 *
 * Folded behind a button, because a list of bookings where every past one
 * carries an open form reads as a questionnaire rather than a list.
 *
 * Nothing here decides whether the booking may be reviewed — the page only
 * offers this for a COMPLETED booking at a venue the player has not reviewed,
 * and the action checks both again. When it succeeds the page re-renders and
 * this gives way to the review as stored, including whether a moderator has
 * yet to look at it.
 */
export function ReviewForm({
  slug,
  bookingId,
  maxLength,
}: {
  /** The booking's club — reviews are submitted to the club they belong to. */
  slug: string;
  bookingId: string;
  maxLength: number;
}) {
  const t = useTranslations('myBookings.review');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    reviewBookingAction.bind(null, slug, bookingId),
    null,
  );

  if (!open) {
    return (
      <div className="mt-3">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {t('rate')}
        </Button>
      </div>
    );
  }

  const ratingId = `rating-${bookingId}`;
  const bodyId = `review-${bookingId}`;

  return (
    <form action={formAction} className="border-border-subtle mt-3 grid gap-3 border-t pt-3">
      <fieldset className="grid gap-1.5">
        <legend id={ratingId} className="text-content-default text-sm font-medium">
          {t('ratingLabel')}
        </legend>
        <RadioGroup name="rating" required aria-labelledby={ratingId} className="flex gap-4">
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="flex items-center gap-1.5">
              <RadioGroupItem value={String(n)} id={`${ratingId}-${n}`} />
              <Label htmlFor={`${ratingId}-${n}`}>{t('stars', { count: n })}</Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor={bodyId}>{t('bodyLabel')}</Label>
        <Textarea id={bodyId} name="body" rows={3} maxLength={maxLength} />
        <p className="text-content-muted text-sm">{t('bodyHint', { max: maxLength })}</p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {t('submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>

      {state && !state.ok && (
        <p role="alert" className="text-content-error text-sm">
          {t(`error.${state.error}` as never)}
        </p>
      )}
    </form>
  );
}
