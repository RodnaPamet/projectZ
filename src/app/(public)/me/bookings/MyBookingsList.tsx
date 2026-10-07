'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { MyBookingDto } from '@/app/api/v1/_lib/dto';
import { PullToRefresh } from '@/components/mobile/PullToRefresh';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { CardListSkeleton } from '@/components/loading/shapes';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { ChevronRight } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type InfiniteKey, type V1Page } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWRInfinite } from '@/lib/data/use-v1-swr';

import { EMPTY_DRAFT, ReviewForm, type ReviewDraft, type ReviewErrorKey } from './ReviewForm';
import type { BookingTab } from './tabs';

/**
 * A player's own bookings, at every club, on `GET /api/v1/me/bookings`.
 *
 * ═══ THE SEED IS PAGE ONE ═══
 *
 * page.tsx reads page one on the server with the endpoint's own mapper and
 * hands it over as `fallbackData`. So the list paints with the HTML — no
 * skeleton, no second paint — and SWR revalidates it once after paint (the
 * cache is empty on a document load, so page one is fetched; `fallbackData`
 * is never written to the cache). On a client navigation back here the cache
 * already holds the list and wins over the seed.
 *
 * `revalidateFirstPage` stays on (SWR's default): "load more" re-reads page
 * one as well as fetching the next. That is one more GET per tap than the
 * moderation queue spends, and it is the right trade here — page one is where
 * a booking made or cancelled since the page loaded shows up, and a player
 * scrolling to older bookings should not be looking at a stale top.
 *
 * ═══ A REVIEW IS OPTIMISTIC, AND COMES BACK IF REFUSED ═══
 *
 * Submitting turns the form into "your review: N of 5 · waiting for a
 * moderator" at once, on every row at that venue (one review per venue, so
 * they all change together, as the server will say once it is re-read). The
 * write goes to the v1 review route; on success the list is re-read, which
 * replaces the guess with the stored status (a star-only review is published
 * at once). On failure SWR restores the rows and the form says why, in the
 * existing words for each refusal.
 *
 * The drafts and errors live HERE, keyed by booking, not in the form: the form
 * unmounts the moment the optimistic review replaces it, and the one that
 * comes back after a rollback is a new instance — it would otherwise return
 * empty, with the person's text and the reason it was refused both gone.
 */

type Item = MyBookingDto;
type Pages = V1Page<Item>[];

/**
 * Stable: a key function is its list's identity (`unstable_serialize`), so each
 * tab's is built once, here. The booking detail page refreshes both after a
 * cancel, by these same functions.
 */
export const BOOKING_LIST_KEYS: Record<BookingTab, InfiniteKey<Item>> = {
  upcoming: KEYS.meBookings({ when: 'upcoming' }),
  past: KEYS.meBookings({ when: 'past' }),
};

/** `StatusBadge` tone per booking status. An unknown (newer) status reads as neutral. */
export const STATUS_TONE: Record<string, StatusBadgeVariant> = {
  PENDING: 'warning',
  CONFIRMED: 'success',
  COMPLETED: 'info',
  CANCELLED: 'neutral',
  NO_SHOW: 'error',
};

interface ReviewArg {
  slug: string;
  bookingId: string;
  venueId: string;
  rating: number;
  body: string;
}

/**
 * The optimistic change: every row at the reviewed venue now carries the
 * caller's review, pending, and offers no form. Pure — SWR may call it on the
 * displayed pages more than once.
 */
export function withPendingReview(pages: Pages, arg: ReviewArg, tempId: string): Pages {
  const review = {
    id: tempId,
    bookingId: arg.bookingId,
    rating: arg.rating,
    status: 'PENDING_REVIEW',
  };
  return pages.map((p) => ({
    ...p,
    items: p.items.map((b) =>
      b.venue.id === arg.venueId && b.clubSlug === arg.slug
        ? { ...b, venueReview: review, canReview: false }
        : b,
    ),
  }));
}

/**
 * The v1 route's refusal → the words already in the catalogue for it.
 *
 *   NO_PROOF_OF_VISIT, ALREADY_REVIEWED   the use case's own, by name;
 *   INVALID_RATING / BAD_REQUEST rating   RATING_REQUIRED;
 *   BAD_REQUEST body                      TOO_LONG (`maxLength` should stop it first);
 *   NOT_FOUND, FORBIDDEN                  NOT_ALLOWED — a club gone or a
 *                                         membership suspended answers 404,
 *                                         by design indistinguishable;
 *   anything else                         FAILED: a network drop, a 5xx.
 */
export function reviewErrorKey(e: unknown): ReviewErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  switch (e.code) {
    case 'NO_PROOF_OF_VISIT':
    case 'ALREADY_REVIEWED':
      return e.code;
    case 'INVALID_RATING':
      return 'RATING_REQUIRED';
    case 'BAD_REQUEST': {
      const field = (e.details as { field?: unknown } | undefined)?.field;
      if (field === 'rating') return 'RATING_REQUIRED';
      if (field === 'body') return 'TOO_LONG';
      return 'FAILED';
    }
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return 'NOT_ALLOWED';
    default:
      return 'FAILED';
  }
}

const EMPTY_PAGE: V1Page<Item> = { items: [], nextCursor: null };

export function MyBookingsList({
  when,
  seed,
  reviewMaxLength,
}: {
  when: BookingTab;
  /**
   * Page one from the server, for the tab the page was opened on. The other
   * tab has none: it is read on first switch, behind a skeleton.
   */
  seed?: V1Page<Item>;
  reviewMaxLength: number;
}) {
  const t = useTranslations('myBookings');
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [errors, setErrors] = useState<Record<string, ReviewErrorKey>>({});
  const getKey = BOOKING_LIST_KEYS[when];

  const { data, error, size, setSize, mutate, isValidating, isLoading } = useV1SWRInfinite<Item>(
    getKey,
    seed ? { fallbackData: [seed] } : {},
  );

  const review = useV1Mutation<ReviewArg, unknown, Pages>({
    url: ({ slug, bookingId }) => V1.review(slug, bookingId),
    // An empty text is a star-only review, sent as no text at all.
    body: ({ rating, body }) => ({ rating, body: body.trim() === '' ? null : body }),
    target: { infinite: mutate, getKey: getKey as InfiniteKey<unknown> },
    update: (pages, arg, { id }) => withPendingReview(pages, arg, id),
    fallback: [seed ?? EMPTY_PAGE],
  });

  const setDraft = useCallback(
    (id: string, draft: ReviewDraft) => setDrafts((prev) => ({ ...prev, [id]: draft })),
    [],
  );

  // T15: a skeleton only while there is nothing at all to show; the seeded
  // tab never has one.
  if (needsSkeleton({ isLoading, data }) && !seed) {
    return (
      <div data-testid="my-bookings-skeleton">
        <CardListSkeleton rows={3} lines={3} className="gap-compact" />
      </div>
    );
  }
  if (!data && !seed && error) {
    return (
      <ErrorState
        title={t('listError.title')}
        description={t('listError.description')}
        onRetry={() => void mutate()}
      />
    );
  }

  const pages = data ?? [seed ?? EMPTY_PAGE];
  const items = pages.flatMap((p) => p.items);
  const nextCursor = pages[pages.length - 1]?.nextCursor ?? null;
  // A page was asked for and has not arrived: in flight, or it failed.
  const loadingMore = size > pages.length;
  const loadMoreFailed = loadingMore && !!error && !isValidating;

  async function submit(b: Item, draft: ReviewDraft) {
    if (!b.clubSlug) return;
    if (draft.rating === null) {
      setErrors((prev) => ({ ...prev, [b.id]: 'RATING_REQUIRED' }));
      return;
    }
    setErrors(({ [b.id]: _cleared, ...rest }) => rest);
    try {
      await review.trigger({
        slug: b.clubSlug,
        bookingId: b.id,
        venueId: b.venue.id,
        rating: draft.rating,
        body: draft.body,
      });
      setDrafts(({ [b.id]: _done, ...rest }) => rest);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [b.id]: reviewErrorKey(e) }));
    }
  }

  if (items.length === 0) {
    return (
      // data-perf-ready: the perf harness's READY marker (docs/perf/README.md).
      <div data-perf-ready>
        <PullToRefresh onRefresh={() => mutate()} />
        <EmptyState title={t(`empty.${when}.title`)} description={t(`empty.${when}.description`)}>
          {/* next/link, not EmptyState's own `href` action: that is a plain
              <a>, a full document load, and the tab bar keeps the chrome
              mounted for a client navigation to /venues. */}
          <Link href="/venues" className={buttonVariants({ variant: 'primary' })}>
            {t('browse')}
          </Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="gap-section grid">
      <PullToRefresh onRefresh={() => mutate()} />

      {/* data-perf-ready: the perf harness's READY marker (docs/perf/README.md). */}
      <ul data-perf-ready className="gap-compact grid">
        {items.map((b) => (
          <BookingCard
            key={b.id}
            booking={b}
            reviewMaxLength={reviewMaxLength}
            draft={drafts[b.id] ?? EMPTY_DRAFT}
            onDraft={(d) => setDraft(b.id, d)}
            error={errors[b.id] ?? null}
            onSubmit={(d) => void submit(b, d)}
          />
        ))}
      </ul>

      {loadMoreFailed && <InlineNotice variant="error">{t('loadMoreError')}</InlineNotice>}

      {nextCursor && (
        <div>
          <Button
            type="button"
            variant="secondary"
            loading={loadingMore && !loadMoreFailed}
            onClick={() => void setSize(pages.length + 1)}
          >
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

function BookingCard({
  booking: b,
  reviewMaxLength,
  draft,
  onDraft,
  error,
  onSubmit,
}: {
  booking: Item;
  reviewMaxLength: number;
  draft: ReviewDraft;
  onDraft: (draft: ReviewDraft) => void;
  error: ReviewErrorKey | null;
  onSubmit: (draft: ReviewDraft) => void;
}) {
  const t = useTranslations('myBookings');
  const tSports = useTranslations('sports');
  const format = useFormatter();

  // ═══ EVERY TIME IS RENDERED IN THE VENUE'S TIMEZONE ═══
  //
  // Not the browser's, and not the server's. A court booked for 19:00 in Sofia
  // is at 19:00 in Sofia whoever is reading the page and wherever they are
  // standing — a player checking their booking from abroad must not be shown
  // 17:00 and turn up two hours late. `Venue.timezone` is stored per venue for
  // exactly this, and the wire times are UTC instants, so the zone is the only
  // step that can be got wrong. Stated per call: next-intl has no app-wide zone.
  const timeZone = b.venue.timezone;
  const when = format.dateTime(new Date(b.startTs), {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone,
  });
  const until = format.dateTime(new Date(b.endTs), { timeStyle: 'short', timeZone });
  const price = format.number(b.totalCents / 100, { style: 'currency', currency: b.currency });

  return (
    <Card as="li" elevation="flat" density="compact" className="bg-bg-default">
      {/* The booking itself opens its detail page (#359, audit P04). Only this
          block is the link: the review form below has controls of its own,
          and a form nested in a link is a click target nobody can predict.
          Default prefetch (T30): the detail page's loading.tsx shell. */}
      <Link
        href={`/me/bookings/${encodeURIComponent(b.id)}`}
        data-testid="booking-card-link"
        className="hover:bg-bg-muted -m-2 block rounded-md p-2 transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
      >
        <div className="gap-compact flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-content-emphasis font-medium">{b.venue.name}</p>
            <p className="text-content-muted text-sm">
              {b.resource.name} · {tSports(b.resource.sport as never)}
            </p>
          </div>
          <div className="gap-tight flex shrink-0 items-center">
            <StatusBadge variant={STATUS_TONE[b.status] ?? 'neutral'}>
              {t(`status.${b.status}` as never)}
            </StatusBadge>
            <ChevronRight className="text-content-muted size-4" aria-hidden="true" />
          </div>
        </div>

        <p className="text-content-default mt-2 text-sm">
          {when} – {until}
        </p>
        <p className="text-content-muted mt-1 text-sm">{price}</p>
      </Link>

      {b.venueReview?.bookingId === b.id ? (
        <p className="text-content-default mt-compact text-sm">
          {t('review.yours', { rating: b.venueReview.rating })}{' '}
          <span className="text-content-muted">
            · {t(`review.status.${b.venueReview.status}` as never)}
          </span>
        </p>
      ) : b.venueReview && b.status === 'COMPLETED' ? (
        <p className="text-content-muted mt-compact text-sm">{t('review.alreadyThisVenue')}</p>
      ) : b.canReview && b.clubSlug ? (
        <ReviewForm
          bookingId={b.id}
          maxLength={reviewMaxLength}
          draft={draft}
          onDraft={onDraft}
          error={error}
          onSubmit={onSubmit}
        />
      ) : null}
    </Card>
  );
}
