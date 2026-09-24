'use client';

/**
 * Epic 49 + Roadmap-21 PR-C — `<CalendarHeatmap>`.
 *
 * GitHub-style activity heatmap (week columns × day rows). Each cell
 * represents one calendar day. R21-PR-C rebuilds the colouring on
 * the R21-PR-A `useHeatScale` foundation: a CONTINUOUS OKLAB ramp
 * driven by chart-series 1 (brand warm yellow/orange), replacing
 * the previous 5-bucket `getIntensityTone` step function. Cells
 * now interpolate smoothly across the activity range rather than
 * snapping to bucket thresholds.
 *
 * The Epic 49 bottom-strip legend (5 swatches between "Less" and
 * "More") is replaced by `<ChartLegend variant="gradient">` from
 * R21-PR-A — the legend gradient paints from the same tokens the
 * cells consume, so legend ↔ cells are visually continuous.
 *
 * One affordance refinement on top:
 *
 *   - Month separators — a soft vertical line between the last
 *     week of one month and the first of the next. Subtle (token-
 *     backed border-subtle alpha), but gives the eye a temporal
 *     anchor without a heavy axis.
 *
 * Sized to a 12-month look-back by default; the `from`/`to` props
 * adjust the rendered range. Bare HTML — no chart library
 * dependency. Token-styled, accessible (`aria-label` per cell), and
 * click-through (`onSelectDate` fires for any clicked cell,
 * populated or empty).
 */

import * as React from 'react';
import { cn } from '@/lib/cn';
import type { CalendarEvent } from '@/app-layer/schemas/calendar.schemas';
import { ChartLegend, useHeatScale } from '@/components/ui/charts';
import { useTranslations } from 'next-intl';

// ─── Public props ─────────────────────────────────────────────────────

export interface CalendarHeatmapProps {
  /** Events to bucket. Heatmap aggregates per-day count. */
  events: ReadonlyArray<CalendarEvent>;
  /** Inclusive range start (defaults to 12 months before `to`). */
  from?: Date;
  /** Inclusive range end (defaults to today). */
  to?: Date;
  /** Click handler — fires with the YYYY-MM-DD of the clicked cell. */
  onSelectDate?: (date: string) => void;
  /** ARIA label for the wrapping <figure>. */
  'aria-label'?: string;
  /** Forwarded for E2E selectors. */
  'data-testid'?: string;
  className?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): Date[] {
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  const days: Date[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    days.push(new Date(t));
  }
  return days;
}

// ─── Component ───────────────────────────────────────────────────────

export function CalendarHeatmap({
  events,
  from,
  to,
  onSelectDate,
  className,
  'aria-label': ariaLabel = 'Compliance activity heatmap',
  'data-testid': dataTestId = 'calendar-heatmap',
}: CalendarHeatmapProps) {
  const t = useTranslations('common.ui');
  // Default range: 12 months back from `to` (or from today).
  const rangeTo = to ?? new Date();
  const rangeFrom = from ?? new Date(rangeTo.getTime() - 365 * DAY_MS);

  // Stabilise object identity for the dependency array — comparing
  // by `.getTime()` avoids re-running on every parent render that
  // happens to construct a new Date for the same instant.
  const fromMs = rangeFrom.getTime();
  const toMs = rangeTo.getTime();
  const days = React.useMemo(
    () => eachDay(rangeFrom, rangeTo),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- using ms-since-epoch as stable identity
    [fromMs, toMs],
  );

  const counts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) {
      const ymd = e.date.slice(0, 10);
      m.set(ymd, (m.get(ymd) ?? 0) + 1);
    }
    return m;
  }, [events]);

  const max = React.useMemo(() => {
    let m = 0;
    for (const v of counts.values()) if (v > m) m = v;
    return m;
  }, [counts]);

  // R21-PR-C — continuous OKLAB heat scale, series 1 (brand warm
  // yellow/orange — the canonical activity hue). The floor 0.15
  // keeps "no activity" cells faintly visible rather than vanishing
  // into the bg — same intent as the Epic 49 bucket-0 tone, just
  // continuous now.
  const heat = useHeatScale({
    domain: [0, Math.max(max, 1)],
    series: 1,
    idPrefix: 'calendar-heat',
  });

  // Group days into 7-row × N-column grid. We pad the start so the
  // first column begins on a Sunday (UTC day index 0).
  const padStart = days.length > 0 ? days[0].getUTCDay() : 0;
  const padded: (Date | null)[] = [...Array.from<null>({ length: padStart }).fill(null), ...days];
  while (padded.length % 7 !== 0) padded.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }

  // R21-PR-C — derive month-boundary flag per week. A week column
  // gets `data-month-start` when its first non-null day's month
  // differs from the previous week's first non-null day's month.
  // CSS paints a 1px left border on that column → subtle month
  // separator without a heavy axis.
  const weekMonthStart: boolean[] = weeks.map((week, i) => {
    if (i === 0) return false;
    const firstThisWeek = week.find((d): d is Date => d !== null);
    const firstPrevWeek = weeks[i - 1].find((d): d is Date => d !== null);
    if (!firstThisWeek || !firstPrevWeek) return false;
    return firstThisWeek.getUTCMonth() !== firstPrevWeek.getUTCMonth();
  });

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <figure
      className={cn('gap-tight flex flex-col', className)}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      <div className="gap-tight flex">
        {/* Row labels (only show every other row to save space). */}
        <div className="text-content-muted flex flex-col gap-[2px] pt-[14px] text-[10px] select-none">
          {dayLabels.map((label, i) => (
            <span key={label} className={cn('h-[10px] leading-[10px]', i % 2 === 0 && 'opacity-0')}>
              {label}
            </span>
          ))}
        </div>

        {/* Heatmap grid */}
        <div className="flex gap-[2px] overflow-x-auto">
          {weeks.map((week, weekIdx) => (
            <div
              key={weekIdx}
              data-month-start={weekMonthStart[weekIdx] ? 'true' : undefined}
              className={cn(
                'flex flex-col gap-[2px]',
                // R21-PR-C — month separator. Subtle 1px
                // tone-shift on the left edge of any week
                // that starts a new month. Token-backed so
                // it adapts to dark/light theme.
                weekMonthStart[weekIdx] && 'border-border-subtle/60 border-l pl-[2px]',
              )}
            >
              {week.map((day, dayIdx) => {
                if (!day) {
                  return <span key={dayIdx} className="h-[10px] w-[10px]" aria-hidden="true" />;
                }
                const ymd = toYMD(day);
                const count = counts.get(ymd) ?? 0;
                const intensity = heat.intensityFor(count);
                const label =
                  count === 0
                    ? `${ymd}: no events`
                    : `${ymd}: ${count} event${count === 1 ? '' : 's'}`;
                return (
                  <button
                    key={dayIdx}
                    type="button"
                    onClick={() => onSelectDate?.(ymd)}
                    title={label}
                    aria-label={label}
                    data-ymd={ymd}
                    data-count={count}
                    data-intensity={intensity.toFixed(2)}
                    className={cn(
                      'h-[10px] w-[10px] rounded-[2px]',
                      'transition-[background-color,outline-color] duration-150',
                      'hover:ring-content-emphasis/40 hover:ring-1',
                      'focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none',
                    )}
                    style={{
                      background: heat.colorFor(count),
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* R21-PR-C: shared gradient legend, painted from the same
                tokens the cells consume — visually continuous. */}
      <figcaption className="flex justify-end">
        <ChartLegend variant="gradient" heatScale={heat} label={t('activity')} unit="" />
      </figcaption>
    </figure>
  );
}
