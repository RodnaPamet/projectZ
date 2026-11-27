'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { CalendarSyncResultDto, MyCalendarDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { KEYS, V1 } from '@/lib/data/keys';
import {
  GOOGLE_CALENDAR_DISCLOSURE_POINTS,
  GOOGLE_CALENDAR_DISCLOSURE_VERSION,
} from '@/lib/google-calendar/disclosure';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { PROFILE_ROW } from './ProfileSection';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

type ResultSentence =
  'connected' | 'access_denied' | 'insufficient_scope' | 'state_expired' | 'failed';

/** The callback's `?googleCalendar=` values (a closed set), each to its sentence. */
const RESULT: Record<string, ResultSentence> = {
  connected: 'connected',
  access_denied: 'access_denied',
  insufficient_scope: 'insufficient_scope',
  state_expired: 'state_expired',
  state_invalid: 'failed',
  token_exchange_failed: 'failed',
  feature_disabled: 'failed',
  internal_error: 'failed',
};

type Failure = 'failed' | 'GOOGLE_REVOKED' | 'GOOGLE_UNAVAILABLE';

/**
 * «Синхронизирай с Google Календар» (owner 2026-11-14), one switch, like
 * Agrent's «Копие в Google Drive».
 *
 * On: first the disclosure (#713, Google's Workspace user-data policy): what
 * we write, what we read, who learns what, and how to stop. «Свържи» is the
 * affirmative action; «Отказ» leaves the switch off. Only then
 * `POST /me/calendar/google/connect` (with the disclosure's version) and off
 * to Google's consent; Google
 * comes back to the callback, which runs the first sync and lands here with
 * `?googleCalendar=connected` (or a code, `result`). Off: `DELETE`, which
 * revokes the grant; the «playerz» calendar stays in Google. Under the switch,
 * while connected: the Google account, the last sync, «Синхронизирай сега».
 */
export function GoogleCalendarRow({
  seed,
  result,
  privacyHref = null,
}: {
  seed: MyCalendarDto;
  /** `?googleCalendar=` on the way back from Google, if any. */
  result?: string | null;
  /** The privacy policy, linked under the disclosure; null while it has no page. */
  privacyHref?: string | null;
}) {
  const t = useTranslations('profile.calendar');
  const tProfile = useTranslations('profile');
  const format = useFormatter();
  const id = useId();
  const key = KEYS.myCalendar();
  const { data } = useV1SWR<MyCalendarDto>(key, { fallbackData: seed });
  const google = (data ?? seed).google;

  const [failed, setFailed] = useState<Failure | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [disclosing, setDisclosing] = useState(false);
  const [lastRun, setLastRun] = useState<CalendarSyncResultDto | null>(null);

  const connect = useV1Mutation<void, { authorizeUrl: string }>({
    url: () => V1.connectGoogleCalendar(),
    body: () => ({ client: 'web', disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE_VERSION }),
  });
  const disconnect = useV1Mutation<void, void, MyCalendarDto>({
    url: () => V1.disconnectGoogleCalendar(),
    method: 'DELETE',
    target: { key },
    update: (visible) => ({
      ...visible,
      google: {
        connected: false,
        email: null,
        lastSyncAt: null,
        lastResult: null,
        error: null,
        disclosureVersion: null,
      },
    }),
    fallback: seed,
  });
  const sync = useV1Mutation<void, CalendarSyncResultDto>({
    url: () => V1.syncGoogleCalendar(),
    related: { keys: (k) => k === key },
  });

  function toggle(on: boolean) {
    setFailed(null);
    setLastRun(null);
    // On asks first: nothing reaches Google before «Свържи» (#713).
    if (on) setDisclosing(true);
    else disconnect.trigger().catch(() => setFailed('failed'));
  }

  /** «Свържи»: the person agreed; off to Google's consent. */
  function agree() {
    setLeaving(true);
    connect
      .trigger()
      .then((answer) => {
        if (!answer?.authorizeUrl) throw new Error('no authorizeUrl');
        window.location.assign(answer.authorizeUrl);
      })
      .catch(() => {
        setLeaving(false);
        setFailed('failed');
      });
  }

  function syncNow() {
    setFailed(null);
    sync
      .trigger()
      .then((r) => setLastRun(r ?? null))
      .catch((e: { code?: string }) =>
        setFailed(
          e.code === 'GOOGLE_CALENDAR_REVOKED'
            ? 'GOOGLE_REVOKED'
            : e.code === 'GOOGLE_CALENDAR_UNAVAILABLE'
              ? 'GOOGLE_UNAVAILABLE'
              : 'failed',
        ),
      );
  }

  const sentence: ResultSentence | null = result ? (RESULT[result] ?? 'failed') : null;
  const busy = leaving || connect.isMutating || disconnect.isMutating;

  return (
    <>
      <div className={PROFILE_ROW} data-testid="profile-google-calendar">
        <div className="min-w-0">
          <Label htmlFor={id} className="text-content-default cursor-pointer text-sm">
            {t('switch')}
          </Label>
          <p className="text-content-muted text-xs">{t('hint')}</p>
        </div>
        <Switch
          id={id}
          checked={google.connected || leaving}
          disabled={busy}
          onCheckedChange={toggle}
          data-testid="profile-google-calendar-switch"
        />
      </div>

      {google.connected ? (
        <div className={PROFILE_ROW} data-testid="profile-google-calendar-status">
          <div className="min-w-0">
            <p className="text-content-default truncate text-sm">
              {google.email ? t('connectedAs', { email: google.email }) : t('connected')}
            </p>
            <p className="text-content-muted text-xs" data-testid="profile-google-calendar-last">
              {google.lastSyncAt
                ? t('lastSync', {
                    when: format.dateTime(new Date(google.lastSyncAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  })
                : t('neverSynced')}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            loading={sync.isMutating}
            onClick={syncNow}
            data-testid="profile-google-calendar-sync"
          >
            {t('syncNow')}
          </Button>
        </div>
      ) : null}

      {disclosing ? (
        <ConfirmDialog
          showModal={disclosing}
          setShowModal={setDisclosing}
          tone="info"
          title={t('disclosure.title')}
          description={
            <div className="space-y-2" data-testid="profile-google-calendar-disclosure">
              <ul className="list-disc space-y-2 ps-5">
                {GOOGLE_CALENDAR_DISCLOSURE_POINTS.map((point) => (
                  <li key={point}>{t(`disclosure.${point}`)}</li>
                ))}
              </ul>
              {privacyHref ? (
                <p>
                  <Link
                    href={privacyHref}
                    target="_blank"
                    rel="noopener"
                    className="text-content-default underline"
                  >
                    {tProfile('legal.privacy')}
                  </Link>
                </p>
              ) : null}
            </div>
          }
          confirmLabel={t('disclosure.connect')}
          cancelLabel={t('disclosure.cancel')}
          onConfirm={agree}
        />
      ) : null}

      {!google.connected && google.error === 'GOOGLE_REVOKED' ? (
        <InlineNotice
          variant="warning"
          className="mx-4 mb-2"
          data-testid="profile-google-calendar-revoked"
        >
          {t('error.GOOGLE_REVOKED')}
        </InlineNotice>
      ) : null}
      {lastRun ? (
        <InlineNotice
          variant="success"
          className="mx-4 mb-2"
          data-testid="profile-google-calendar-done"
        >
          {lastRun.partial ? t('donePartial') : t('done')}
        </InlineNotice>
      ) : null}
      {sentence && !failed && !lastRun ? (
        <InlineNotice
          variant={result === 'connected' ? 'success' : 'error'}
          className="mx-4 mb-2"
          data-testid="profile-google-calendar-result"
        >
          {t(`result.${sentence}`)}
        </InlineNotice>
      ) : null}
      {failed ? (
        <InlineNotice
          variant="error"
          className="mx-4 mb-2"
          data-testid="profile-google-calendar-failed"
        >
          {failed === 'failed' ? t('failed') : t(`error.${failed}`)}
        </InlineNotice>
      ) : null}
    </>
  );
}
