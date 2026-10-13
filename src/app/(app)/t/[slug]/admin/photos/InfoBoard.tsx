'use client';

import { useActionState, useId } from 'react';
import { useTranslations } from 'next-intl';

import type { ClubInfo } from '@/app-layer/usecases/club-info';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';

import { saveClubDescriptionAction, saveVenueInfoAction, type InfoActionResult } from './actions';

/**
 * «Информация» (#530): what the club says about itself and about each venue
 * on their public pages. One card for the club, one per venue; each saves on
 * its own, through an action that authorises itself (`admin.venue_manage`).
 *
 * The name and the address are not here: the operator sets them, because they
 * feed the public address, the map and the search.
 */
export function InfoBoard({
  slug,
  info,
  maxDescription,
}: {
  slug: string;
  info: ClubInfo;
  maxDescription: number;
}) {
  const t = useTranslations('admin.photos.info');

  return (
    <section className="gap-default mb-section grid" aria-labelledby="club-info-title">
      <Heading level={2} id="club-info-title">
        {t('title')}
      </Heading>
      <ClubCard slug={slug} description={info.description} max={maxDescription} />
      {info.venues.map((v) => (
        <VenueCard key={v.id} slug={slug} venue={v} max={maxDescription} />
      ))}
    </section>
  );
}

function Outcome({ state, pending }: { state: InfoActionResult | null; pending: boolean }) {
  const t = useTranslations('admin.photos.info');
  if (!state || pending) return null;
  return state.ok ? (
    <InlineNotice variant="success" data-info-saved>
      {t('saved')}
    </InlineNotice>
  ) : (
    <InlineNotice variant="error" data-info-error>
      {t(`error.${state.error}`)}
    </InlineNotice>
  );
}

function ClubCard({
  slug,
  description,
  max,
}: {
  slug: string;
  description: string | null;
  max: number;
}) {
  const t = useTranslations('admin.photos.info');
  const ids = useId();
  const [state, save, pending] = useActionState(saveClubDescriptionAction.bind(null, slug), null);

  return (
    <Card density="compact" elevation="flat" className="bg-bg-default" data-info-club>
      <form action={save} className="gap-compact grid">
        <FormField label={t('club.label')} description={t('club.hint', { max })}>
          <Textarea
            id={`${ids}-club`}
            name="description"
            rows={4}
            defaultValue={description ?? ''}
            maxLength={max}
          />
        </FormField>
        <Outcome state={state} pending={pending} />
        <div>
          <Button type="submit" variant="secondary" loading={pending}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function VenueCard({
  slug,
  venue,
  max,
}: {
  slug: string;
  venue: ClubInfo['venues'][number];
  max: number;
}) {
  const t = useTranslations('admin.photos.info');
  const ids = useId();
  const [state, save, pending] = useActionState(
    saveVenueInfoAction.bind(null, slug, venue.id),
    null,
  );

  return (
    <Card density="compact" elevation="flat" className="bg-bg-default" data-info-venue={venue.id}>
      <form action={save} className="gap-compact grid">
        <Heading level={3}>{venue.name}</Heading>
        <FormField label={t('venue.description')} description={t('venue.hint', { max })}>
          <Textarea
            id={`${ids}-description`}
            name="description"
            rows={4}
            defaultValue={venue.description ?? ''}
            maxLength={max}
          />
        </FormField>
        <FormField label={t('venue.phone')} description={t('venue.phoneHint')}>
          <Input
            id={`${ids}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            defaultValue={venue.phone ?? ''}
            maxLength={40}
          />
        </FormField>
        <Outcome state={state} pending={pending} />
        <div>
          <Button type="submit" variant="secondary" loading={pending}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
