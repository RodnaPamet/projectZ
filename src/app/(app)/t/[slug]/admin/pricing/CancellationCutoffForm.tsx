'use client';

import { useActionState, useId } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { MAX_CANCELLATION_CUTOFF_HOURS } from '@/lib/booking/cutoff';

import { setCancellationCutoffAction } from './actions';

export interface CutoffVenue {
  id: string;
  name: string;
  cancellationCutoffHours: number;
}

/**
 * How long before the start a player may cancel in the app (#354).
 *
 * One field per venue, because the cutoff lives on the venue — a club with one
 * site sees one field. Shown to holders of `admin.venue_manage` (OWNER and
 * MANAGER); the action checks it again.
 */
export function CancellationCutoffForm({
  slug,
  venues,
}: {
  slug: string;
  venues: readonly CutoffVenue[];
}) {
  const t = useTranslations('admin.pricing.cutoff');
  if (venues.length === 0) return null;

  return (
    <Card as="section" density="compact" className="mb-section">
      <Heading level={2}>{t('title')}</Heading>
      <p className="text-content-muted mb-default mt-1 text-sm">{t('description')}</p>
      <div className="gap-default grid">
        {venues.map((v) => (
          <VenueCutoff key={v.id} slug={slug} venue={v} />
        ))}
      </div>
    </Card>
  );
}

function VenueCutoff({ slug, venue }: { slug: string; venue: CutoffVenue }) {
  const t = useTranslations('admin.pricing.cutoff');
  const ids = useId();
  const [state, formAction, pending] = useActionState(
    setCancellationCutoffAction.bind(null, slug, venue.id),
    null,
  );

  return (
    <form action={formAction} className="gap-compact flex flex-wrap items-end">
      <div className="sm:max-w-xs">
        <FormField label={t('label', { venue: venue.name })}>
          <Input
            id={`${ids}-hours`}
            name="hours"
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            max={MAX_CANCELLATION_CUTOFF_HOURS}
            defaultValue={venue.cancellationCutoffHours}
            required
          />
        </FormField>
      </div>
      <Button type="submit" disabled={pending}>
        {t('save')}
      </Button>
      {state && !pending && !state.ok && (
        <InlineNotice variant="error">
          {t('invalid', { max: MAX_CANCELLATION_CUTOFF_HOURS })}
        </InlineNotice>
      )}
      {state?.ok && !pending && <InlineNotice variant="success">{t('saved')}</InlineNotice>}
    </form>
  );
}
