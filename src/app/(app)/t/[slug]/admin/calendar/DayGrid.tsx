'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatusBadge } from '@/components/ui/status-badge';
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

  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);
  const byCourt = new Map<string, DayBooking[]>();
  for (const b of bookings) {
    const list = byCourt.get(b.resourceId);
    if (list) list.push(b);
    else byCourt.set(b.resourceId, [b]);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          href={`/t/${slug}/admin/calendar?day=${prevDay}`}
          className="border-border-subtle rounded-md border px-3 py-2 text-sm"
        >
          {t('nav.previous')}
        </Link>
        <span className="font-medium">{dayLabel}</span>
        <Link
          href={`/t/${slug}/admin/calendar?day=${nextDay}`}
          className="border-border-subtle rounded-md border px-3 py-2 text-sm"
        >
          {t('nav.next')}
        </Link>
        {!isToday && (
          <Link href={`/t/${slug}/admin/calendar`} className="text-content-muted text-sm underline">
            {t('nav.today')}
          </Link>
        )}
      </div>

      <div className="flex gap-4 text-sm">
        <span className="flex items-center gap-1.5">
          <span className="bg-bg-success inline-block h-3 w-3 rounded-sm" />
          {t('legend.confirmed')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="border-border-strong inline-block h-3 w-3 rounded-sm border border-dashed" />
          {t('legend.pending')}
        </span>
      </div>

      <p className="text-content-muted mt-2 text-sm">{t('noShow.hint')}</p>

      {refusal && (
        <p role="alert" className="text-content-error mt-2 text-sm">
          {t(`noShow.error.${refusal}` as never)}
        </p>
      )}

      {courts.length === 0 ? (
        <p data-perf-ready className="text-content-muted mt-6 text-sm">
          {t('noCourts')}
        </p>
      ) : (
        // Horizontal scroll rather than a reflow: a club with eight courts on
        // a phone wants to swipe across a diary it recognises, not read eight
        // stacked lists.
        // data-perf-ready: the perf harness's READY marker (docs/perf/README.md).
        <div data-perf-ready className="mt-4 overflow-x-auto">
          <div
            className="grid min-w-max"
            style={{ gridTemplateColumns: `4rem repeat(${courts.length}, minmax(9rem, 1fr))` }}
          >
            <div />
            {courts.map((c) => (
              <div
                key={c.id}
                className="border-border-subtle border-b px-2 pb-2 text-sm font-medium"
              >
                {c.name}
                {c.venueName && (
                  <span className="text-content-muted block text-xs font-normal">
                    {c.venueName}
                  </span>
                )}
              </div>
            ))}

            <div>
              {hours.map((h) => (
                <div
                  key={h}
                  className="text-content-muted pr-2 text-right text-xs tabular-nums"
                  style={{ height: ROW_HEIGHT }}
                >
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>

            {courts.map((court) => (
              <div
                key={court.id}
                className="border-border-subtle relative border-l"
                style={{ height: hours.length * ROW_HEIGHT }}
              >
                {hours.map((h) => (
                  <div
                    key={h}
                    className="border-border-subtle border-b"
                    style={{ height: ROW_HEIGHT }}
                  />
                ))}

                {(byCourt.get(court.id) ?? []).map((b) => {
                  const pending = b.status === 'PENDING';
                  const className = [
                    'absolute inset-x-1 overflow-hidden rounded-md px-2 py-1 text-xs',
                    pending
                      ? 'border-border-strong text-content-muted border border-dashed'
                      : 'bg-bg-success text-content-success',
                  ].join(' ');
                  const style = {
                    top: (b.startOffsetMinutes / 60) * ROW_HEIGHT,
                    // A one-line minimum, so a 15-minute booking is still
                    // readable rather than a sliver with clipped text.
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
                        <span className="ml-1">{t('expiresAt', { time: b.expiresLabel })}</span>
                      )}
                    </>
                  );

                  if (!b.canMarkNoShow) {
                    return (
                      <div key={b.id} className={className} style={style}>
                        {content}
                      </div>
                    );
                  }

                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`${className} focus-visible:ring-focus-ring cursor-pointer text-left focus-visible:ring-2 focus-visible:outline-none`}
                      style={style}
                      aria-label={t('noShow.open', {
                        who: b.who,
                        start: b.startLabel,
                        end: b.endLabel,
                      })}
                      onClick={() => {
                        setRefusal(null);
                        setNoShowTarget(b);
                        setConfirmOpen(true);
                      }}
                    >
                      {content}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {bookings.length === 0 && courts.length > 0 && (
        <p className="text-content-muted mt-4 text-sm">{t('emptyDay', { day: isoDay })}</p>
      )}

      <p className="text-content-muted mt-6 text-sm">
        <StatusBadge variant="neutral">{t('tz.badge')}</StatusBadge> {t('tz.note')}
      </p>

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
          onConfirm={async () => {
            const result = await markNoShowAction(slug, noShowTarget.id);
            // A refusal closes the dialog and is shown above the grid, where it
            // stays readable; the grid itself refreshes on success.
            if (!result.ok) setRefusal(result.error);
          }}
        />
      )}
    </>
  );
}
