'use client';

import { useActionState, useId } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import {
  MAX_MAX_UPCOMING_ONLINE_BOOKINGS,
  MIN_MAX_UPCOMING_ONLINE_BOOKINGS,
} from '@/lib/booking/online-cap';

import { setOnlineBookingCapAction } from './actions';

/**
 * How many upcoming ONLINE bookings one player may hold at the club (#380).
 *
 * One field for the whole club — the cap lives on `VenueOrg`. Shown to holders
 * of `admin.venue_manage` (OWNER and MANAGER); the action checks it again.
 */
export function OnlineBookingCapForm({ slug, limit }: { slug: string; limit: number }) {
  const t = useTranslations('admin.pricing.bookingCap');
  const ids = useId();
  const [state, formAction, pending] = useActionState(
    setOnlineBookingCapAction.bind(null, slug),
    null,
  );

  return (
    <Card as="section" density="compact" className="mb-section">
      <Heading level={2}>{t('title')}</Heading>
      <p className="text-content-muted mb-default mt-1 text-sm">{t('description')}</p>
      <form action={formAction} className="gap-compact flex flex-wrap items-end">
        <div className="sm:max-w-xs">
          <FormField label={t('label')}>
            <Input
              id={`${ids}-limit`}
              name="limit"
              type="number"
              inputMode="numeric"
              step="1"
              min={MIN_MAX_UPCOMING_ONLINE_BOOKINGS}
              max={MAX_MAX_UPCOMING_ONLINE_BOOKINGS}
              defaultValue={limit}
              required
            />
          </FormField>
        </div>
        <Button type="submit" disabled={pending}>
          {t('save')}
        </Button>
        {state && !pending && !state.ok && (
          <InlineNotice variant="error">
            {t('invalid', {
              min: MIN_MAX_UPCOMING_ONLINE_BOOKINGS,
              max: MAX_MAX_UPCOMING_ONLINE_BOOKINGS,
            })}
          </InlineNotice>
        )}
        {state?.ok && !pending && <InlineNotice variant="success">{t('saved')}</InlineNotice>}
      </form>
    </Card>
  );
}
