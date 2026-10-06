'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { AvailabilityDto } from '@/app/api/v1/_lib/dto';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/** Times shown on a card before "+N". */
export const FREE_TIMES_SHOWN = 4;

/**
 * The start times still free today at any court of one venue, earliest
 * first, deduplicated across courts: what a player scanning a club's venues
 * wants to know before opening one.
 *
 * Pure, so a test can pin it without a component.
 */
export function freeStartsToday(availability: AvailabilityDto, now: number): string[] {
  const starts = new Set<string>();
  for (const r of availability.resources) {
    for (const s of r.slots) {
      if (s.available && Date.parse(s.startTs) > now) starts.add(s.startTs);
    }
  }
  return [...starts].sort((a, b) => Date.parse(a) - Date.parse(b));
}

/**
 * One club-page venue card's "Свободно днес" (#356).
 *
 * The seed is the server's read of `GET /api/v1/venues/{id}/availability?date=`
 * for today at the club (see the page); this holds it under that endpoint's
 * key and revalidates after paint and on focus (T15). The same key is the
 * venue page's first day, so opening the venue next finds today cached.
 *
 * "Already started" is judged against the server's render time first, so
 * the client renders exactly what the server did, then against this clock,
 * refreshed each minute: a card left open over 18:00 stops offering 18:00.
 */
const MINUTE_MS = 60_000;

export function FreeToday({
  venueId,
  timezone,
  date,
  seed,
  renderedAt,
}: {
  venueId: string;
  timezone: string;
  /** Today at the club, `YYYY-MM-DD`. */
  date: string;
  seed: AvailabilityDto;
  renderedAt: string;
}) {
  const t = useTranslations('club');
  const format = useFormatter();
  const [now, setNow] = useState(() => Date.parse(renderedAt));

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);

  const { data, error } = useV1SWR<AvailabilityDto>(KEYS.venueAvailability(venueId, { date }), {
    fallbackData: seed,
  });

  const starts = useMemo(() => (data ? freeStartsToday(data, now) : []), [data, now]);

  // The seed is always there, so `data` is never undefined here; an error
  // with data on screen keeps the data (it is at most one revalidation old).
  if (!data && error) {
    return <Caption>{t('freeError')}</Caption>;
  }
  if (starts.length === 0) {
    return <Caption>{t('noneToday')}</Caption>;
  }

  const shown = starts.slice(0, FREE_TIMES_SHOWN);
  const more = starts.length - shown.length;
  return (
    <div className="flex flex-col gap-1">
      <Caption>{t('freeToday')}</Caption>
      <ul aria-label={t('freeToday')} className="flex flex-wrap gap-1">
        {shown.map((s) => (
          <li key={s}>
            <StatusBadge variant="success" icon={null}>
              {format.dateTime(new Date(s), {
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
                timeZone: timezone,
              })}
            </StatusBadge>
          </li>
        ))}
        {more > 0 && (
          <li>
            <StatusBadge variant="neutral" icon={null}>
              {t('freeMore', { count: more })}
            </StatusBadge>
          </li>
        )}
      </ul>
    </div>
  );
}
