'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { refreshSession } from '@/lib/i18n/persist-my-locale';
import { loadPage } from '@/lib/navigation/load-page';

/**
 * The two ends of the acceptance step (#462).
 *
 * Both finish the same way: have next-auth re-read what the account has
 * accepted into the session token (`refreshSession`, the CSRF-checked update
 * `auth.ts` answers from the database), then LOAD the destination
 * (`loadPage`): a full load, not a router push, because the router may still
 * hold the redirect that brought the person here for that very address. Once
 * per version.
 */
async function goOn(to: string) {
  await refreshSession();
  loadPage(to);
}

/** «Приемам»: record the acceptance, refresh the session, continue. */
export function AcceptLegal({ to }: { to: string }) {
  const t = useTranslations('onboarding.terms');
  const [failed, setFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const accept = useV1Mutation<void>({ url: () => V1.legalAcceptance() });

  async function submit() {
    setFailed(false);
    try {
      await accept.trigger();
      setLeaving(true);
      await goOn(to);
    } catch {
      setLeaving(false);
      setFailed(true);
    }
  }

  return (
    <div className="gap-compact flex flex-col">
      {failed ? (
        <InlineNotice variant="error" data-testid="legal-error">
          {t('error')}
        </InlineNotice>
      ) : null}
      <Button
        type="button"
        onClick={() => void submit()}
        loading={accept.isMutating || leaving}
        data-testid="legal-accept"
      >
        {t('accept')}
      </Button>
    </div>
  );
}

/** Nothing is due after all: refresh the stale session and continue, unasked. */
export function LegalStepDone({ to }: { to: string }) {
  const t = useTranslations('onboarding.terms');
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    goOn(to).catch(() => setFailed(true));
  }, [to]);

  if (!failed) {
    return (
      <p className="text-content-muted text-sm" role="status" data-testid="legal-continuing">
        {t('continuing')}
      </p>
    );
  }
  return (
    <div className="gap-compact flex flex-col">
      <InlineNotice variant="error" data-testid="legal-error">
        {t('error')}
      </InlineNotice>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setFailed(false);
          goOn(to).catch(() => setFailed(true));
        }}
      >
        {t('retry')}
      </Button>
    </div>
  );
}
