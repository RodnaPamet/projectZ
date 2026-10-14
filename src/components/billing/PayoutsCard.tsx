'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

/**
 * «Онлайн плащания» (#581; decision 41): the club connects its own Stripe
 * account, and entry fees paid online go there. Stripe's hosted onboarding
 * takes the club's details and bank account; the club comes back here. It
 * can take payments once Stripe says so, which can be a while after the
 * form is finished.
 */
export function PayoutsCard({
  slug,
  status,
  back,
}: {
  slug: string;
  status: 'NONE' | 'PENDING' | 'READY';
  /** `?onboarding=` on the way back from Stripe. */
  back: 'complete' | 'refresh' | null;
}) {
  const t = useTranslations('admin.payouts');
  const [failed, setFailed] = useState(false);
  const start = useV1Mutation<void, { onboardingUrl: string }>({
    url: () => V1.connectOnboarding(slug),
  });

  async function go() {
    setFailed(false);
    try {
      const r = await start.trigger();
      if (r?.onboardingUrl) window.location.assign(r.onboardingUrl);
    } catch {
      setFailed(true);
    }
  }

  return (
    <Card elevation="flat" className="gap-compact flex flex-col" data-testid="payouts-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading level={2} className="text-base">
          {t('heading')}
        </Heading>
        <StatusBadge
          variant={status === 'READY' ? 'success' : status === 'PENDING' ? 'warning' : 'neutral'}
          icon={null}
          data-testid="payouts-status"
        >
          {
            { NONE: t('status.NONE'), PENDING: t('status.PENDING'), READY: t('status.READY') }[
              status
            ]
          }
        </StatusBadge>
      </div>
      <Caption>
        {{ NONE: t('body.NONE'), PENDING: t('body.PENDING'), READY: t('body.READY') }[status]}
      </Caption>
      {back === 'complete' && status !== 'READY' ? (
        <InlineNotice variant="info">{t('back.complete')}</InlineNotice>
      ) : null}
      {back === 'refresh' ? (
        <InlineNotice variant="warning">{t('back.refresh')}</InlineNotice>
      ) : null}
      {failed ? <InlineNotice variant="error">{t('failed')}</InlineNotice> : null}
      {status !== 'READY' ? (
        <Button
          type="button"
          className="self-start"
          loading={start.isMutating}
          disabled={start.isMutating}
          onClick={() => void go()}
          data-testid="payouts-connect"
        >
          {status === 'NONE' ? t('connect') : t('continue')}
        </Button>
      ) : null}
    </Card>
  );
}
