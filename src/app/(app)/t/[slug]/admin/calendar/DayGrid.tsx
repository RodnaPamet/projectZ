'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { StatusBadge } from '@/components/ui/status-badge';

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
 * would tell them it is sold. It gets a hatched, muted block and its expiry.
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
}

export interface GridCourt {
  id: string;
  name: string;
}

const ROW_HEIGHT = 56;

export function DayGrid({
  slug,
  isoDay,
  prevDay,
  nextDay,
  isToday,
  dayLabel,
  courts,
  bookings,
  firstHour,
  lastHour,
}: {
  slug: string;
  isoDay: string;
  prevDay: string;
  nextDay: string;
  isToday: boolean;
  dayLabel: string;
  courts: readonly GridCourt[];
  bookings: readonly DayBooking[];
  firstHour: number;
  lastHour: number;
}) {
  const t = useTranslations('admin.calendar');

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

      {courts.length === 0 ? (
        <p className="text-content-muted mt-6 text-sm">{t('noCourts')}</p>
      ) : (
        // Horizontal scroll rather than a reflow: a club with eight courts on
        // a phone wants to swipe across a diary it recognises, not read eight
        // stacked lists.
        <div className="mt-4 overflow-x-auto">
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
                  return (
                    <div
                      key={b.id}
                      className={[
                        'absolute inset-x-1 overflow-hidden rounded-md px-2 py-1 text-xs',
                        pending
                          ? 'border-border-strong text-content-muted border border-dashed'
                          : 'bg-bg-success text-content-success',
                      ].join(' ')}
                      style={{
                        top: (b.startOffsetMinutes / 60) * ROW_HEIGHT,
                        // A one-line minimum, so a 15-minute booking is still
                        // readable rather than a sliver with clipped text.
                        height: Math.max((b.durationMinutes / 60) * ROW_HEIGHT - 2, 22),
                      }}
                    >
                      <span className="font-medium">{b.who}</span>
                      <span className="ml-1 tabular-nums">
                        {b.startLabel}–{b.endLabel}
                      </span>
                      <span className="ml-1 tabular-nums">{b.priceLabel}</span>
                      {pending && b.expiresLabel && (
                        <span className="ml-1">{t('expiresAt', { time: b.expiresLabel })}</span>
                      )}
                    </div>
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
    </>
  );
}
