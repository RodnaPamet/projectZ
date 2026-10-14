'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { AvailabilityDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';
import { bookingDays } from '@/lib/booking/days';
import { allowedMinutes, offersFor } from '@/lib/booking/offers';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

/** The earliest a proposed match starts, as the server holds it (#591). */
const LEAD_MS = 2 * 3_600_000;

export interface ProposedTime {
  resourceId: string;
  startTs: string;
  durationMinutes: number;
}

/**
 * A league match's player proposes a court and a time (#591; decisions 62,
 * 63): the venue's free starts, day by day, as on its page, from two hours
 * from now. The court is held in their name at its price, paid at the club,
 * until the other side answers.
 */
export function ProposeMatchSheet({
  venue,
  opponents,
  busy,
  onClose,
  onSubmit,
}: {
  venue: { id: string; timezone: string };
  opponents: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (p: ProposedTime) => void;
}) {
  const t = useTranslations('tournaments.propose');
  const format = useFormatter();
  const [now] = useState(() => Date.now());
  const days = useMemo(() => bookingDays(new Date(now), venue.timezone), [now, venue.timezone]);
  const [day, setDay] = useState(days[0]!);
  const [court, setCourt] = useState<string | null>(null);
  const [picked, setPicked] = useState<ProposedTime | null>(null);
  const { data } = useV1SWR<AvailabilityDto>(KEYS.venueAvailability(venue.id, { date: day }));

  const resource = data?.resources.find((r) => r.resourceId === court) ?? data?.resources[0];
  const minutes = resource ? (allowedMinutes(resource)[0] ?? resource.minBookingMinutes) : 0;
  const offers = resource
    ? offersFor(resource, minutes, now + LEAD_MS - 1).filter(
        (o) => Date.parse(o.startTs) >= now + LEAD_MS,
      )
    : [];
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: venue.timezone,
    });
  const price = (cents: number, currency: string) =>
    format.number(cents / 100, {
      style: 'currency',
      currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    });

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('title')}
      size="sm"
    >
      <Sheet.Header title={t('title')} description={t('description', { opponents })} />
      <Sheet.Body className="gap-section grid content-start">
        <ToggleGroup
          options={days.map((d) => ({
            value: d,
            label: format.dateTime(new Date(`${d}T12:00:00Z`), {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            }),
          }))}
          selected={day}
          selectAction={(d) => {
            setDay(d);
            setPicked(null);
          }}
          ariaLabel={t('day')}
          size="sm"
          className="flex-wrap justify-self-start"
        />
        {!data ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : data.resources.length === 0 ? (
          <Caption>{t('none')}</Caption>
        ) : (
          <>
            {data.resources.length > 1 ? (
              <ToggleGroup
                options={data.resources.map((r) => ({ value: r.resourceId, label: r.name }))}
                selected={resource!.resourceId}
                selectAction={(c) => {
                  setCourt(c);
                  setPicked(null);
                }}
                ariaLabel={t('court')}
                size="sm"
                className="flex-wrap justify-self-start"
              />
            ) : null}
            {offers.length === 0 ? (
              <Caption>{t('none')}</Caption>
            ) : (
              <div
                role="group"
                aria-label={t('times', { court: resource!.name })}
                className="grid grid-cols-3 gap-2 sm:grid-cols-4"
                data-testid="propose-times"
              >
                {offers.map((o) => {
                  const selected =
                    picked?.resourceId === resource!.resourceId && picked.startTs === o.startTs;
                  return (
                    <Button
                      key={o.startTs}
                      type="button"
                      variant={selected ? 'primary' : 'secondary'}
                      aria-pressed={selected}
                      className="tabular-nums"
                      onClick={() =>
                        setPicked({
                          resourceId: resource!.resourceId,
                          startTs: o.startTs,
                          durationMinutes: o.minutes,
                        })
                      }
                    >
                      {time(o.startTs)} · {price(o.priceCents, resource!.currency)}
                    </Button>
                  );
                })}
              </div>
            )}
          </>
        )}
        <Caption>{t('hint')}</Caption>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            loading={busy}
            disabled={busy || !picked}
            onClick={() => picked && onSubmit(picked)}
            data-testid="propose-send"
          >
            {t('send')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </Sheet.Body>
    </Sheet>
  );
}
