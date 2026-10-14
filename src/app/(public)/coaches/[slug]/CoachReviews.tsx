'use client';

import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { CoachReviewsPageDto } from '@/app/api/v1/_lib/coach-dto';
import { ReportDialog } from '@/components/messages/ReportDialog';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1, type InfiniteKey, type V1Page } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import type { ReportReason } from '@/lib/messaging/report';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

type Page = CoachReviewsPageDto;
type Item = Page['items'][number];

/**
 * «Отзиви» on a coach's page (#551; owner decisions 24–27): the rating as
 * venues show it, then the published reviews, newest first, ten at a time.
 *
 * Each names its author by first name and initial, never more. The author's
 * own carries «Изтрий» (a new one can then be written); everybody else's
 * carries «Подай сигнал» for a signed-in reader, the coach included, through
 * the dialog messages use. The coach cannot remove one.
 *
 * Page one comes from the server with the page; "more" reads the endpoint.
 */
export function CoachReviews({
  slug,
  seed,
  signedIn,
}: {
  slug: string;
  seed: Page;
  signedIn: boolean;
}) {
  const t = useTranslations('coaches.reviews');
  const format = useFormatter();
  const getKey = useMemo(() => KEYS.coachReviews(slug) as InfiniteKey<Item>, [slug]);
  const { data, error, size, setSize, mutate, isValidating } = useV1SWRInfinite<Item>(getKey, {
    fallbackData: [seed],
  });
  const pages = (data ?? [seed]) as Page[];
  const rating = pages[0]?.rating ?? seed.rating;
  const items = pages.flatMap((p) => p.items);
  const nextCursor = pages.at(-1)?.nextCursor ?? null;
  const loadingMore = size > pages.length;
  const loadMoreFailed = loadingMore && !!error && !isValidating;

  const [reporting, setReporting] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const report = useV1Mutation<{ id: string; reason: ReportReason; details: string }>({
    url: ({ id }) => V1.reportCoachReview(id),
    body: ({ reason, details }) => ({ reason, ...(details ? { details } : {}) }),
  });
  const remove = useV1Mutation<{ id: string }, unknown, V1Page<Item>[]>({
    url: ({ id }) => V1.myCoachReview(id),
    method: 'DELETE',
    target: { infinite: mutate, getKey: getKey as InfiniteKey<unknown> },
    update: (visible, { id }) =>
      visible.map((p) => ({ ...p, items: p.items.filter((r) => r.id !== id) })),
    fallback: [seed],
  });

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteFailed(false);
    try {
      await remove.trigger({ id: deleting });
      setDeleteOpen(false);
    } catch {
      setDeleteFailed(true);
      setDeleteOpen(false);
    }
  }

  return (
    <section
      aria-labelledby="coach-reviews"
      className="flex flex-col gap-3"
      data-testid="coach-reviews"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading level={2} id="coach-reviews" className="text-lg">
          {t('title')}
        </Heading>
        {rating.reviewCount > 0 ? (
          <span className="text-sm" data-testid="coach-reviews-rating">
            {t('summary', {
              rating: format.number(rating.avgRating, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              }),
              count: rating.reviewCount,
            })}
          </span>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="text-content-muted text-sm" data-testid="coach-reviews-none">
          {t('none')}
        </p>
      ) : (
        <ul className="grid gap-3">
          {items.map((r) => (
            <li
              key={r.id}
              className="border-border-subtle bg-bg-default rounded-lg border p-3"
              data-testid="coach-review"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-content-emphasis text-sm font-medium">
                  {r.author ?? t('anonymous')}
                  {r.mine ? <span className="text-content-muted"> · {t('yours')}</span> : null}
                </span>
                <Caption>
                  {format.dateTime(new Date(r.createdAt), {
                    dateStyle: 'medium',
                    // The platform's zone: a review is dated as the club's day is.
                    timeZone: 'Europe/Sofia',
                  })}
                </Caption>
              </div>
              {/* The stars are a picture of the number: read as «4 от 5 звезди». */}
              <p className="text-sm">
                <span role="img" aria-label={t('stars', { rating: r.rating })}>
                  <span aria-hidden="true">
                    {'★'.repeat(r.rating)}
                    <span className="text-content-muted">{'★'.repeat(5 - r.rating)}</span>
                  </span>
                </span>
              </p>
              {r.body ? <p className="mt-1 text-sm whitespace-pre-wrap">{r.body}</p> : null}
              {r.mine ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  data-testid="coach-review-delete"
                  onClick={() => {
                    setDeleting(r.id);
                    setDeleteOpen(true);
                  }}
                  text={t('delete')}
                />
              ) : signedIn ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  data-testid="coach-review-report"
                  onClick={() => {
                    setReporting(r.id);
                    setReportOpen(true);
                  }}
                  text={t('report')}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {deleteFailed ? <InlineNotice variant="error">{t('deleteFailed')}</InlineNotice> : null}
      {loadMoreFailed ? <InlineNotice variant="error">{t('moreError')}</InlineNotice> : null}

      {nextCursor ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            loading={loadingMore && !loadMoreFailed}
            onClick={() => void setSize(pages.length + 1)}
            text={t('more')}
          />
        </div>
      ) : null}

      {reporting ? (
        <ReportDialog
          key={reporting}
          open={reportOpen}
          setOpen={setReportOpen}
          subject="review"
          onSubmit={(body) => report.trigger({ id: reporting, ...body })}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          showModal={deleteOpen}
          setShowModal={setDeleteOpen}
          tone="danger"
          title={t('deleteTitle')}
          description={t('deleteDescription')}
          confirmLabel={t('deleteYes')}
          cancelLabel={t('keep')}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </section>
  );
}
