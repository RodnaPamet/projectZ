'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';

import { markNoShowAction } from './actions';
import type { DiaryDay } from './diary-day';
import { useFreshDiaryDay } from './use-fresh-diary-day';

/**
 * One day, every court, side by side — the front-desk view.
 *
 * ═══ EVERY TIME HERE IS ALREADY THE CLUB'S ═══
 *
 * The server resolved each booking to the club's wall clock and sent strings.
 * Nothing in this component calls `new Date()` or `toLocaleTimeString`: doing
 * so would render the VIEWER's timezone, so a manager checking the diary from
 * abroad would see every booking shifted, and the grid would disagree with the
 * hours it is drawn against.
 *
 * That is the same trap `availability.ts` documents for opening hours and the
 * diary repository documents for the day window. It has three sides and this
 * is the third.
 *
 * ═══ PENDING IS DRAWN DIFFERENTLY, NOT HIDDEN ═══
 *
 * A PENDING booking holds the slot until `expiresAt`. Hiding it would tell
 * staff a court is free while somebody is mid-checkout; drawing it identically
 * would tell them it is sold. It gets a dashed, muted outline rather than a
 * filled block, plus its expiry time.
 *
 * ═══ A BOOKING THAT HAS STARTED CAN BE MARKED A NO-SHOW ═══
 *
 * The block itself is the control — a court standing empty is noticed while
 * looking at the diary, and a separate list would be one more place to look.
 * Whether it qualifies is decided on the server (`canMarkNoShow`) and decided
 * AGAIN by the use case, because the sweep or the player may have moved the
 * booking since this page rendered; a refusal comes back as a message.
 *
 * ═══ ON THE PRIMITIVES (T26) ═══
 *
 * The day links are `buttonVariants` on a `<Link>` (they navigate, so they stay
 * anchors: the perf harness clicks `main a[href=…?day=…]`, and a middle-click
 * opens the day in a tab). Each court is a `Card`, the legend and the pending
 * expiry are `StatusBadge`s in the same tokens as the blocks they explain, and
 * a refusal is an `InlineNotice`. The court cards sit on a CSS subgrid, so
 * every court's header row is as tall as the tallest one (a multi-site club
 * adds a venue line) and every timeline starts on the same line as the hour
 * ruler, without measuring anything.
 */

export interface DayBooking {
  id: string;
  resourceId: string;
  /** "18:00" in the club's timezone, resolved server-side. */
  startLabel: string;
  endLabel: string;
  /** Minutes from the grid's first hour, for placement. */
  startOffsetMinutes: number;
  durationMinutes: number;
  status: string;
  who: string;
  priceLabel: string;
  expiresLabel: string | null;
  /** Started, and CONFIRMED or COMPLETED. The use case re-checks it. */
  canMarkNoShow: boolean;
}

export interface GridCourt {
  id: string;
  name: string;
  /** Set only when the club has more than one site; null otherwise. */
  venueName: string | null;
}

const ROW_HEIGHT = 56;

type DayLink = 'prev' | 'next' | 'today';

/**
 * The day link a keyboard user just followed, so the new day can put focus
 * back on it.
 *
 * A `?day=` change is a new page segment (Next keys the page by its search
 * params), so the grid — and the link that had focus — unmounts, and focus
 * falls to <body>. Stepping a week forward would then mean tabbing back
 * through the whole club nav seven times. Module state, because it has to
 * outlive that unmount; it names the day it is for, so a later visit to some
 * other day never steals focus.
 */
let refocusAfterDayChange: { slug: string; requestedDay: string | null; link: DayLink } | null =
  null;

/**
 * Put focus back on the block the confirm was opened from, once the confirm
 * has gone, if nothing else took it.
 *
 * The desktop Dialog does this itself (modal.tsx's onCloseAutoFocus). The
 * phone's bottom sheet does not: measured at 393 px, cancelling left focus on
 * <body>, so a screen-reader user was thrown back to the top of the page. The
 * sheet is the vendored Modal, fixed upstream rather than here (#329);
 * until then this waits out its close (a few frames, capped at ~1.5 s) and
 * restores focus only from <body>, so it is a no-op wherever the Dialog has
 * already done it.
 */
function returnFocusAfterClose(opener: HTMLElement | null) {
  let frames = 90;
  const tick = () => {
    const active = document.activeElement;
    if (!opener?.isConnected || active === opener) return;
    if (active === null || active === document.body) {
      opener.focus();
      return;
    }
    if (--frames > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function DayGrid({
  slug,
  requestedDay,
  day,
}: {
  slug: string;
  /** The URL's `?day=` as given, or null for the club's today. */
  requestedDay: string | null;
  /**
   * The day as the server built it (`diary-day.ts`). A diary revisited from
   * the router cache (staleTimes.dynamic, 30 s) paints at once, then
   * re-fetches this day in the background if what it shows is older than
   * STALE_AFTER_MS (10 s): bookings arrive from phones all day, and this is
   * the front desk's live view. Only the day is re-fetched, never the route
   * (#314): see use-fresh-diary-day.ts.
   */
  day: DiaryDay;
}) {
  const t = useTranslations('admin.calendar');
  const { isoDay, prevDay, nextDay, isToday, dayLabel, courts, bookings, firstHour, lastHour } =
    useFreshDiaryDay(slug, requestedDay, day);
  const [noShowTarget, setNoShowTarget] = useState<DayBooking | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const navRef = useRef<HTMLDivElement>(null);
  const dayHeadingRef = useRef<HTMLHeadingElement>(null);
  // The booking just marked: its block leaves the grid with the revalidated
  // payload (NO_SHOW is not a diary status), taking the dialog's focus target
  // with it.
  const markedRef = useRef<string | null>(null);
  // The block the confirm was opened from.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const pending = refocusAfterDayChange;
    if (!pending || pending.slug !== slug || pending.requestedDay !== requestedDay) return;
    refocusAfterDayChange = null;
    // "Today" is not rendered ON today; the day's heading is the next best
    // place, and it is what changed.
    const link = navRef.current?.querySelector<HTMLElement>(`[data-diary-day="${pending.link}"]`);
    (link ?? dayHeadingRef.current)?.focus();
  }, [slug, requestedDay]);

  useEffect(() => {
    const marked = markedRef.current;
    if (!marked || confirmOpen || bookings.some((b) => b.id === marked)) return;
    markedRef.current = null;
    // The dialog returns focus to the block it was opened from only while
    // that block exists (modal.tsx checks `isConnected`). A marked booking's
    // block is gone, so focus would fall to <body>; the day heading keeps a
    // keyboard user inside the diary.
    dayHeadingRef.current?.focus();
  }, [confirmOpen, bookings]);

  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);
  const byCourt = new Map<string, DayBooking[]>();
  for (const b of bookings) {
    const list = byCourt.get(b.resourceId);
    if (list) list.push(b);
    else byCourt.set(b.resourceId, [b]);
  }

  const dayLink = (link: DayLink, target: string | null) => ({
    href: target ? `/t/${slug}/admin/calendar?day=${target}` : `/t/${slug}/admin/calendar`,
    'data-diary-day': link,
    // Auto prefetch (docs/perf/navigation-policy.md: the `?day=` links keep
    // the default; never `prefetch={true}` on club admin).
    onClick: () => {
      refocusAfterDayChange = { slug, requestedDay: target, link };
    },
  });

  return (
    <div className="gap-default grid">
      <div ref={navRef} className="gap-tight flex flex-wrap items-center">
        <Link {...dayLink('prev', prevDay)} className={buttonVariants({ variant: 'secondary' })}>
          {t('nav.previous')}
        </Link>
        {/* Below sm the day is its own row above the two links (measured at
            393 px: "‹ Предишен ден", the Bulgarian day and "Следващ ден ›"
            took three rows). DOM order stays prev, day, next, and the
            heading is not in the tab order, so `order` moves no focus stop. */}
        <Heading
          level={2}
          ref={dayHeadingRef}
          tabIndex={-1}
          className="sm:px-tight order-first w-full focus:outline-none sm:order-none sm:w-auto"
        >
          {dayLabel}
        </Heading>
        <Link {...dayLink('next', nextDay)} className={buttonVariants({ variant: 'secondary' })}>
          {t('nav.next')}
        </Link>
        {!isToday && (
          <Link {...dayLink('today', null)} className={buttonVariants({ variant: 'ghost' })}>
            {t('nav.today')}
          </Link>
        )}
      </div>

      <div className="gap-tight grid">
        {/* The legend's badges are painted in the blocks' own tokens, so each
            one is a swatch of what it explains. */}
        <div className="gap-tight flex flex-wrap items-center">
          <StatusBadge variant="success" tone="solid" icon={null}>
            {t('legend.confirmed')}
          </StatusBadge>
          <StatusBadge
            variant="neutral"
            icon={null}
            className="border-border-strong border border-dashed bg-transparent"
          >
            {t('legend.pending')}
          </StatusBadge>
        </div>
        <Caption>{t('noShow.hint')}</Caption>
      </div>

      {refusal && (
        <InlineNotice variant="error" onDismiss={() => setRefusal(null)}>
          {t(`noShow.error.${refusal}` as never)}
        </InlineNotice>
      )}

      {courts.length === 0 ? (
        <Caption data-perf-ready>{t('noCourts')}</Caption>
      ) : (
        // Horizontal scroll rather than a reflow: a club with eight courts on
        // a phone wants to swipe across a diary it recognises, not read eight
        // stacked lists. The scroller is the only thing wider than the page,
        // so the page itself never drifts.
        // data-perf-ready: the perf harness's READY marker (docs/perf/README.md).
        <div data-perf-ready className="overflow-x-auto pb-1">
          <div
            className="gap-x-tight grid min-w-max grid-rows-[auto_auto]"
            style={{ gridTemplateColumns: `3.5rem repeat(${courts.length}, minmax(9rem, 1fr))` }}
          >
            {/* The hour ruler, in the timeline row. The court cards' headers
                share the row above through the subgrid. */}
            <div className="col-start-1 row-start-2" aria-hidden="true">
              {hours.map((h) => (
                <div
                  key={h}
                  className="text-content-muted pr-1 text-right text-xs tabular-nums"
                  style={{ height: ROW_HEIGHT }}
                >
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>

            {courts.map((court, i) => (
              <Card
                as="section"
                key={court.id}
                elevation="flat"
                density="none"
                aria-labelledby={`diary-court-${court.id}`}
                className="bg-bg-default row-span-2 row-start-1 grid grid-rows-subgrid"
                style={{ gridColumnStart: i + 2 }}
              >
                <div className="border-border-subtle px-tight border-b py-2">
                  <Heading level={3} id={`diary-court-${court.id}`}>
                    {court.name}
                  </Heading>
                  {court.venueName && <Caption className="text-xs">{court.venueName}</Caption>}
                </div>

                <div className="relative" style={{ height: hours.length * ROW_HEIGHT }}>
                  {hours.map((h, row) => (
                    <div
                      key={h}
                      className={cn(row > 0 && 'border-border-subtle border-t')}
                      style={{ height: ROW_HEIGHT }}
                    />
                  ))}

                  {(byCourt.get(court.id) ?? []).map((b) => (
                    <BookingBlock
                      key={b.id}
                      booking={b}
                      onMarkNoShow={(opener) => {
                        openerRef.current = opener;
                        setRefusal(null);
                        setNoShowTarget(b);
                        setConfirmOpen(true);
                      }}
                    />
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {bookings.length === 0 && courts.length > 0 && (
        <Caption>{t('emptyDay', { day: isoDay })}</Caption>
      )}

      <Caption>
        <StatusBadge variant="neutral">{t('tz.badge')}</StatusBadge> {t('tz.note')}
      </Caption>

      {noShowTarget && (
        <ConfirmDialog
          showModal={confirmOpen}
          setShowModal={setConfirmOpen}
          tone="warning"
          title={t('noShow.confirmTitle')}
          description={t('noShow.confirmBody', {
            who: noShowTarget.who,
            start: noShowTarget.startLabel,
            end: noShowTarget.endLabel,
          })}
          confirmLabel={t('noShow.confirm')}
          onCancel={() => returnFocusAfterClose(openerRef.current)}
          onConfirm={async () => {
            const result = await markNoShowAction(slug, noShowTarget.id);
            // A refusal closes the dialog and is shown above the grid, where it
            // stays readable, and focus goes back to the block, which is still
            // there. On success the revalidated payload drops the block.
            if (result.ok) markedRef.current = noShowTarget.id;
            else {
              setRefusal(result.error);
              returnFocusAfterClose(openerRef.current);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * One booking, placed on its court's timeline. A plain block, or — once it has
 * started and is CONFIRMED or COMPLETED — the button that opens the no-show
 * confirm.
 */
function BookingBlock({
  booking: b,
  onMarkNoShow,
}: {
  booking: DayBooking;
  onMarkNoShow: (opener: HTMLElement) => void;
}) {
  const t = useTranslations('admin.calendar');
  const pending = b.status === 'PENDING';
  const className = cn(
    'absolute inset-x-1 overflow-hidden rounded-md px-2 py-1 text-xs',
    pending
      ? 'border-border-strong text-content-muted border border-dashed'
      : 'bg-bg-success text-content-success',
  );
  const style = {
    top: (b.startOffsetMinutes / 60) * ROW_HEIGHT,
    // A one-line minimum, so a 15-minute booking is still readable rather
    // than a sliver with clipped text.
    height: Math.max((b.durationMinutes / 60) * ROW_HEIGHT - 2, 22),
  };
  const content = (
    <>
      <span className="font-medium">{b.who}</span>
      <span className="ml-1 tabular-nums">
        {b.startLabel}–{b.endLabel}
      </span>
      <span className="ml-1 tabular-nums">{b.priceLabel}</span>
      {pending && b.expiresLabel && (
        <StatusBadge size="sm" icon={null} className="ml-1 align-middle">
          {t('expiresAt', { time: b.expiresLabel })}
        </StatusBadge>
      )}
    </>
  );

  if (!b.canMarkNoShow) {
    return (
      <div className={className} style={style} data-booking-status={b.status}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        className,
        'focus-visible:ring-focus-ring cursor-pointer text-left focus-visible:ring-2 focus-visible:outline-none',
      )}
      style={style}
      data-booking-status={b.status}
      aria-label={t('noShow.open', { who: b.who, start: b.startLabel, end: b.endLabel })}
      onClick={(event) => onMarkNoShow(event.currentTarget)}
    >
      {content}
    </button>
  );
}
