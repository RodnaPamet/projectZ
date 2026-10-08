'use client';

import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { DeskBookingDto } from '@/app/api/v1/_lib/desk-dto';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import type { ResourceNoun } from '@/lib/sports/resource-kinds';

import { customerBody, DeskCustomerFields, type DeskCustomerValue } from './DeskCustomerFields';

/**
 * A desk booking's detail (#364), opened by tapping its block in the diary:
 * who, when, the phone to ring, the linked player, the price paid at the club,
 * the club's notes and its series. From here staff change the customer, cancel
 * this booking, cancel the rest of its series, or — once it has started — mark
 * a no-show.
 *
 * The two cancels and the no-show are confirmed in the diary's ConfirmDialog,
 * after this sheet closes: one overlay at a time, which is what a phone's
 * bottom sheet can carry.
 */

export type DeskCancelRequest =
  { kind: 'one'; booking: DeskBookingDto } | { kind: 'rest'; booking: DeskBookingDto };

export default function DeskBookingDetails({
  slug,
  bookingId,
  noun,
  canMarkNoShow,
  onClose,
  onChanged,
  onCancel,
  onMarkNoShow,
}: {
  slug: string;
  bookingId: string;
  /** The booked court's noun (P51): a karting track is a "писта". */
  noun: ResourceNoun;
  canMarkNoShow: boolean;
  onClose: () => void;
  /** The customer changed: the diary re-reads its day. */
  onChanged: () => void;
  onCancel: (request: DeskCancelRequest) => void;
  onMarkNoShow: () => void;
}) {
  const t = useTranslations('admin.calendar.desk.detail');
  const ts = useTranslations('myBookings.status');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const ids = useId();
  const key = KEYS.deskBooking(slug, bookingId);
  const { data: b, error } = useV1SWR<DeskBookingDto>(key);

  const [editing, setEditing] = useState<DeskCustomerValue | null>(null);
  const [applyToSeries, setApplyToSeries] = useState(true);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const update = useV1Mutation<Record<string, unknown>, DeskBookingDto>({
    url: () => V1.updateDeskBooking(slug, bookingId),
    method: 'PATCH',
    body: (arg) => arg,
    target: { key },
  });

  const day = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });
  const live = b?.status === 'CONFIRMED' || b?.status === 'PENDING';
  const editBody = editing ? customerBody(editing) : null;

  const save = async () => {
    if (!editBody) return;
    setFailed(false);
    try {
      await update.trigger({
        customer: editBody,
        ...(b?.series ? { applyToSeries } : {}),
      });
      setEditing(null);
      setSaved(true);
      onChanged();
    } catch {
      setFailed(true);
    }
  };

  const title = b?.customer.name ?? t('title');

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      size="sm"
    >
      <Sheet.Header
        title={title}
        description={
          b ? t('when', { date: day(b.date), start: b.startTime, end: b.endTime }) : undefined
        }
      />
      <Sheet.Body className="gap-section grid content-start" data-desk-detail>
        {error && <InlineNotice variant="error">{t('loadError')}</InlineNotice>}
        {!b && !error && (
          <div className="gap-default grid">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        )}

        {b && !editing && (
          <dl className="gap-default grid grid-cols-[auto_1fr] gap-x-4">
            <dt className="text-content-muted">{t(noun === 'track' ? 'track.court' : 'court')}</dt>
            <dd>{b.resource.name}</dd>

            <dt className="text-content-muted">{t('phone')}</dt>
            <dd>
              {b.customer.phone ? (
                <a className="text-content-emphasis underline" href={`tel:${b.customer.phone}`}>
                  {b.customer.phone}
                </a>
              ) : (
                '—'
              )}
            </dd>

            <dt className="text-content-muted">{t('player')}</dt>
            <dd>
              {b.player
                ? b.player.deleted
                  ? tCommon('deletedUser')
                  : (b.player.name ?? b.player.email)
                : t('noPlayer')}
            </dd>

            <dt className="text-content-muted">{t('price')}</dt>
            <dd className="tabular-nums">
              {t('payAtClub', {
                price: format.number(b.totalCents / 100, {
                  style: 'currency',
                  currency: b.currency,
                }),
              })}
            </dd>

            {b.notes && (
              <>
                <dt className="text-content-muted">{t('notes')}</dt>
                <dd className="whitespace-pre-line">{b.notes}</dd>
              </>
            )}
          </dl>
        )}

        {b && !live && (
          <StatusBadge variant="neutral">
            {ts.has(b.status as never) ? ts(b.status as never) : b.status}
          </StatusBadge>
        )}

        {b?.series && !editing && (
          <div className="gap-tight grid" data-desk-series>
            <Heading level={3}>{t('series')}</Heading>
            <Caption>
              {t('seriesSummary', {
                start: b.series.startTime,
                last: day(b.series.cancelledFrom ?? b.series.lastDate),
                count: b.series.remaining,
              })}
            </Caption>
          </div>
        )}

        {editing && (
          <div className="gap-default grid" data-desk-edit>
            <DeskCustomerFields slug={slug} value={editing} onChange={setEditing} />
            {b?.series && (
              <div className="gap-tight flex min-h-11 items-center">
                <Switch
                  id={`${ids}-series`}
                  checked={applyToSeries}
                  onCheckedChange={setApplyToSeries}
                />
                <Label htmlFor={`${ids}-series`} className="cursor-pointer py-3">
                  {t('applyToSeries')}
                </Label>
              </div>
            )}
            <div className="gap-tight flex flex-wrap">
              <Button type="button" onClick={save} disabled={!editBody} loading={update.isMutating}>
                {t('save')}
              </Button>
            </div>
          </div>
        )}

        {saved && !editing && <InlineNotice variant="success">{t('saved')}</InlineNotice>}
        {failed && <InlineNotice variant="error">{t('actionError')}</InlineNotice>}

        {b && live && !editing && (
          <div className="gap-tight flex flex-wrap" data-desk-actions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setSaved(false);
                setEditing({
                  name: b.customer.name ?? '',
                  phone: b.customer.phone ?? '',
                  linked: b.player
                    ? { value: b.player.id, label: b.player.name ?? b.player.email }
                    : null,
                });
              }}
            >
              {t('edit')}
            </Button>
            {canMarkNoShow && (
              <Button type="button" variant="secondary" onClick={onMarkNoShow}>
                {t('markNoShow')}
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              onClick={() => onCancel({ kind: 'one', booking: b })}
            >
              {t('cancelBooking')}
            </Button>
            {b.series && b.series.remaining > 1 && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => onCancel({ kind: 'rest', booking: b })}
              >
                {t('cancelRest')}
              </Button>
            )}
          </div>
        )}
      </Sheet.Body>
    </Sheet>
  );
}
