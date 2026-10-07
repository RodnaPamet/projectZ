import { cn } from '@/lib/cn';

/**
 * A row of small vertical bars, one per period, each as tall as that period's
 * online share (#371). Drawn with the theme's own tokens — the fill is
 * `bg-brand-emphasis`, the track `bg-bg-subtle` — so it reads in light and dark
 * without a colour of its own, and it is CSS, not a charting library.
 *
 * The bars are decoration for a screen reader: the container carries `label`,
 * which the caller writes out in words, and every bar is hidden. A period with
 * no bookings has no share and shows an empty track, not a zero bar.
 */
export interface ShareBar {
  key: string;
  /** 0–1, or null when the period had no bookings. */
  share: number | null;
  /** Under the bar, when given (a month's short name). */
  caption?: string;
}

export function ShareBars({
  bars,
  label,
  size = 'md',
  className,
}: {
  bars: readonly ShareBar[];
  /** What the bars say, in words: the accessible name of the whole row. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const height = size === 'sm' ? 'h-6' : 'h-16';
  return (
    <div role="img" aria-label={label} className={cn('flex items-end gap-1', className)}>
      {bars.map((b) => (
        <div key={b.key} aria-hidden className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className={cn(
              'bg-bg-subtle relative w-full overflow-hidden rounded-sm',
              height,
              size === 'sm' ? 'min-w-1.5' : 'min-w-4',
            )}
          >
            {b.share !== null && (
              <div
                data-share-bar
                className="bg-brand-emphasis absolute inset-x-0 bottom-0 rounded-sm"
                style={{ height: `${Math.max(2, Math.round(b.share * 100))}%` }}
              />
            )}
          </div>
          {b.caption && <span className="text-content-muted text-xs">{b.caption}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * One horizontal bar, `value` of `max` wide: a funnel step's count against the
 * first step's. Same tokens as ShareBars; hidden from a screen reader, which
 * gets the count and the conversion as text beside it.
 */
export function MeterBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div aria-hidden className="bg-bg-subtle h-2 w-full overflow-hidden rounded-full">
      {value > 0 && (
        <div
          className="bg-brand-emphasis h-full rounded-full"
          style={{ width: `${Math.max(1, pct)}%` }}
        />
      )}
    </div>
  );
}
