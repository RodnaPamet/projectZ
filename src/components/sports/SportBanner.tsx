import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { sportArt } from '@/lib/sports/art';

/**
 * A sport's banner photo filling its box under the ink scrims of the phone
 * (owner 2026-11-13, "Full match with the phone"): darker on the leading
 * side where the words sit, and at the foot. Decoration only (`alt=""`): the
 * sport's name is always beside it. Nothing for a sport without a picture,
 * so the box keeps whatever it had under it.
 *
 * Put it in a `relative overflow-hidden` box; it fills it.
 */
export function SportBackdrop({
  sport,
  scrim = 'strong',
  priority = false,
}: {
  sport: string | null | undefined;
  /** `strong` behind a headline; `light` where only a club's tile sits on it. */
  scrim?: 'strong' | 'light';
  priority?: boolean;
}) {
  const src = sportArt(sport);
  if (!src) return null;
  return (
    <div aria-hidden="true" className="absolute inset-0">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static 1320px WebP from public/, decoration only */}
      <img
        src={src}
        alt=""
        width={1320}
        height={480}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        className="size-full object-cover"
      />
      <div
        className={cn(
          'absolute inset-0',
          scrim === 'strong'
            ? 'bg-[linear-gradient(90deg,color-mix(in_srgb,var(--photo-ink)_86%,transparent)_0%,color-mix(in_srgb,var(--photo-ink)_52%,transparent)_50%,transparent_95%)]'
            : 'bg-[linear-gradient(90deg,color-mix(in_srgb,var(--photo-ink)_25%,transparent)_0%,transparent_70%)]',
        )}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_45%,color-mix(in_srgb,var(--photo-ink)_66%,transparent)_100%)]" />
    </div>
  );
}

/**
 * A short banner at the top of a sport's page: the photo, a title and a line
 * under it, on the ink scrim. As the phone's SportBanner.
 */
export function SportBanner({
  sport,
  title,
  subtitle,
  trailing,
  className,
  headingLevel = 2,
}: {
  sport: string;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
  className?: string;
  /** The heading's level in the page's outline. */
  headingLevel?: 2 | 3;
}) {
  const Tag = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      className={cn(
        'relative isolate flex min-h-28 items-end gap-2 overflow-hidden rounded-[14px] border border-[var(--photo-edge)] bg-[var(--photo-ink)] p-4',
        className,
      )}
    >
      <SportBackdrop sport={sport} />
      <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
        <Tag className="font-display text-[1.875rem] leading-none font-black text-white uppercase italic">
          {title}
        </Tag>
        {subtitle && <p className="text-sm text-[var(--photo-muted)]">{subtitle}</p>}
      </div>
      {trailing && <div className="relative text-sm font-semibold text-white">{trailing}</div>}
    </section>
  );
}
