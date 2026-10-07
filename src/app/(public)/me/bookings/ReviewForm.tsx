'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';

/** What the person has typed so far, held by the list (see MyBookingsList). */
export interface ReviewDraft {
  open: boolean;
  rating: number | null;
  body: string;
}

export const EMPTY_DRAFT: ReviewDraft = { open: false, rating: null, body: '' };

/** `myBookings.review.error.*`. FAILED is anything the others do not name. */
export type ReviewErrorKey =
  | 'RATING_REQUIRED'
  | 'TOO_LONG'
  | 'NO_PROOF_OF_VISIT'
  | 'ALREADY_REVIEWED'
  | 'NOT_ALLOWED'
  | 'FAILED';

/**
 * Rate the venue a completed booking was at.
 *
 * Folded behind a button, because a list of bookings where every past one
 * carries an open form reads as a questionnaire rather than a list.
 *
 * Controlled: the draft and the error are the list's, because this unmounts
 * the moment the optimistic review takes its place, and if the server refuses
 * it the form that comes back must still hold the person's rating, their text
 * and the reason (see MyBookingsList). Nothing here decides whether the booking
 * may be reviewed — the server says so (`canReview` on the row) and the v1
 * route checks it again under a lock.
 */
export function ReviewForm({
  bookingId,
  maxLength,
  draft,
  onDraft,
  error,
  onSubmit,
}: {
  bookingId: string;
  maxLength: number;
  draft: ReviewDraft;
  onDraft: (draft: ReviewDraft) => void;
  error: string | null;
  onSubmit: (draft: ReviewDraft) => void;
}) {
  const t = useTranslations('myBookings.review');

  if (!draft.open) {
    return (
      <div className="mt-compact">
        <Button type="button" variant="secondary" onClick={() => onDraft({ ...draft, open: true })}>
          {t('rate')}
        </Button>
      </div>
    );
  }

  const ratingId = `rating-${bookingId}`;
  const bodyId = `review-${bookingId}`;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft);
      }}
      className="border-border-subtle mt-compact gap-compact grid border-t pt-3"
    >
      <fieldset className="grid gap-1.5">
        <legend id={ratingId} className="text-content-default text-sm font-medium">
          {t('ratingLabel')}
        </legend>
        <RadioGroup
          name="rating"
          required
          aria-labelledby={ratingId}
          value={draft.rating === null ? '' : String(draft.rating)}
          onValueChange={(v) => onDraft({ ...draft, rating: Number(v) })}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
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
        <Textarea
          id={bodyId}
          name="body"
          rows={3}
          maxLength={maxLength}
          value={draft.body}
          onChange={(e) => onDraft({ ...draft, body: e.target.value })}
        />
        <p className="text-content-muted text-sm">{t('bodyHint', { max: maxLength })}</p>
      </div>

      <div className="gap-tight flex">
        <Button type="submit">{t('submit')}</Button>
        <Button type="button" variant="ghost" onClick={() => onDraft({ ...draft, open: false })}>
          {t('cancel')}
        </Button>
      </div>

      {error && <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>}
    </form>
  );
}
