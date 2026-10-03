'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useCopyToClipboard } from '@/components/ui/hooks/use-copy-to-clipboard';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR } from '@/lib/data/use-v1-swr';

import { StepUpForm } from '../StepUpForm';

/**
 * Two-step verification for a platform admin (#262): enrol an authenticator,
 * keep the recovery codes, confirm this device, print new codes.
 *
 * ═══ EVERY SECRET IS SHOWN ONCE, AND HELD ONLY IN THIS COMPONENT ═══
 *
 * The enrolment secret and the recovery codes arrive in a POST response and
 * live in component state until the person moves on. They are never put in
 * the SWR cache (which outlives the component) and never re-fetched: the
 * server keeps the secret encrypted and the codes hashed, and has no way to
 * show either again. So "I have saved them" is a real step, not decoration.
 *
 * ═══ IT DECIDES NOTHING ═══
 *
 * Whether the account is enrolled and whether this session is stepped up is
 * `GET /api/v1/me/mfa`, re-read after every change. The binding enforces the
 * step-up on the session row; this page only reports it.
 */

interface MfaStatus {
  eligible: boolean;
  enrolled: boolean;
  pending: boolean;
  stepUpExpiresAt: string | null;
  recoveryCodesRemaining: number;
}

/** Error codes this page has words for. Anything else reads as UNKNOWN. */
const KNOWN = new Set([
  'MFA_CODE_REJECTED',
  'MFA_NOT_ELIGIBLE',
  'MFA_REAUTH_REQUIRED',
  'MFA_ALREADY_ENROLLED',
  'MFA_ENROLMENT_NOT_STARTED',
  'MFA_ENROLMENT_REQUIRED',
  'STEP_UP_REQUIRED',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'NETWORK',
  'VIEWER_CHANGED',
]);

const knownCode = (e: unknown) => (isApiClientError(e) && KNOWN.has(e.code) ? e.code : 'UNKNOWN');

/** Same clock as the moderation queue: the platform reads in Sofia time. */
const TIME_ZONE = 'Europe/Sofia';

/** `ABCDEFGH…` → `ABCD EFGH …`, so a key typed by hand is typed in fours. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

export function SecurityPanel() {
  const t = useTranslations('platform.security');
  const format = useFormatter();
  const status = useV1SWR<MfaStatus>(KEYS.mfaStatus());
  const [error, setError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const keyCopy = useCopyToClipboard();
  const codesCopy = useCopyToClipboard();

  const start = useV1Mutation<void, { secret: string; otpauthUri: string }>({
    url: () => V1.mfaEnrol(),
  });
  const confirm = useV1Mutation<{ code: string }, { recoveryCodes: string[] }>({
    url: () => V1.mfaConfirm(),
    body: (arg) => arg,
  });
  const regenerate = useV1Mutation<void, { recoveryCodes: string[] }>({
    url: () => V1.mfaRecoveryCodes(),
  });

  async function run<R>(fn: () => Promise<R>): Promise<R | undefined> {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      const c = knownCode(e);
      if (c === 'STEP_UP_REQUIRED') setNeedsStepUp(true);
      setError(c);
      return undefined;
    } finally {
      void status.mutate();
    }
  }

  if (needsSkeleton(status)) return <CardListSkeleton rows={1} lines={3} />;
  if (status.error && !status.data) {
    return (
      <InlineNotice variant="error">{t(`error.${knownCode(status.error)}` as never)}</InlineNotice>
    );
  }
  const s = status.data;
  if (!s) return null;

  // The recovery codes, the moment they exist — before anything else, because
  // this is the only time they can be shown.
  if (codes) {
    return (
      <section className="grid gap-3 sm:max-w-xl" aria-labelledby="recovery-title">
        <h2 id="recovery-title" className="text-content-emphasis text-lg font-semibold">
          {t('recovery.title')}
        </h2>
        <p className="text-content-muted text-sm">{t('recovery.intro')}</p>
        <ul className="border-border-subtle bg-bg-muted grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border p-4 font-mono text-sm tabular-nums">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void codesCopy.copy(codes.join('\n'))}
          >
            {codesCopy.copied ? t('enrol.copied') : t('recovery.copyAll')}
          </Button>
          <Button type="button" onClick={() => setCodes(null)}>
            {t('recovery.done')}
          </Button>
        </div>
      </section>
    );
  }

  const statusBadge = s.enrolled ? (
    <StatusBadge variant="success">{t('status.on')}</StatusBadge>
  ) : s.pending ? (
    <StatusBadge variant="warning">{t('status.pending')}</StatusBadge>
  ) : (
    <StatusBadge variant="neutral">{t('status.off')}</StatusBadge>
  );

  return (
    <div className="grid gap-6">
      <p className="flex items-center gap-2 text-sm">
        <span className="text-content-muted">{t('status.label')}</span>
        {statusBadge}
      </p>

      {error && <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>}

      {!s.enrolled && !s.eligible && <InlineNotice variant="info">{t('notEligible')}</InlineNotice>}

      {!s.enrolled && s.eligible && (
        <section className="grid gap-4 sm:max-w-xl">
          <p className="text-content-default text-sm">{t('enrol.intro')}</p>
          {error === 'MFA_REAUTH_REQUIRED' && (
            <InlineNotice variant="warning">{t('enrol.reauth')}</InlineNotice>
          )}

          {!enrolment ? (
            <div>
              <Button
                type="button"
                loading={start.isMutating}
                onClick={() =>
                  void run(async () => {
                    const r = await start.trigger(undefined);
                    if (r) setEnrolment(r);
                  })
                }
              >
                {s.pending ? t('enrol.restart') : t('enrol.start')}
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <p className="text-content-emphasis font-medium">1. {t('enrol.step1')}</p>
                <div>
                  <a
                    href={enrolment.otpauthUri}
                    className={buttonVariants({ variant: 'secondary' })}
                  >
                    {t('enrol.openApp')}
                  </a>
                </div>
                <p className="text-content-muted text-sm">{t('enrol.manual')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="border-border-subtle bg-bg-muted rounded-md border px-3 py-2 font-mono text-sm break-all">
                    {grouped(enrolment.secret)}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void keyCopy.copy(enrolment.secret)}
                  >
                    {keyCopy.copied ? t('enrol.copied') : t('enrol.copyKey')}
                  </Button>
                </div>
              </div>

              <form
                className="grid gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const c = code.replace(/\s/g, '');
                  if (!/^\d{6}$/.test(c)) return;
                  void run(async () => {
                    const r = await confirm.trigger({ code: c });
                    setCode('');
                    if (r) {
                      setEnrolment(null);
                      setCodes(r.recoveryCodes);
                    }
                  });
                }}
              >
                <p className="text-content-emphasis font-medium">2. {t('enrol.step2')}</p>
                <Label htmlFor="mfa-enrol-code">{t('enrol.codeLabel')}</Label>
                <Input
                  id="mfa-enrol-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={7}
                  spellCheck={false}
                />
                <div>
                  <Button
                    type="submit"
                    loading={confirm.isMutating}
                    disabled={!/^\d{6}$/.test(code.replace(/\s/g, ''))}
                  >
                    {t('enrol.confirm')}
                  </Button>
                </div>
              </form>
            </>
          )}
        </section>
      )}

      {s.enrolled && (
        <>
          <p className="text-content-default text-sm">
            {s.stepUpExpiresAt
              ? t('stepUp.active', {
                  time: format.dateTime(new Date(s.stepUpExpiresAt), {
                    timeStyle: 'short',
                    timeZone: TIME_ZONE,
                  }),
                })
              : t('stepUp.inactive')}
          </p>

          {(!s.stepUpExpiresAt || needsStepUp) && (
            <StepUpForm
              onStepped={() => {
                setNeedsStepUp(false);
                setError(null);
                void status.mutate();
              }}
            />
          )}

          <section className="grid gap-2 sm:max-w-xl" aria-labelledby="recovery-heading">
            <h2 id="recovery-heading" className="text-content-emphasis text-lg font-semibold">
              {t('recovery.title')}
            </h2>
            <p className="text-content-muted text-sm">
              {t('recovery.remaining', { count: s.recoveryCodesRemaining })}
            </p>
            <p className="text-content-muted text-sm">{t('recovery.regenerateHint')}</p>
            <div>
              <Button
                type="button"
                variant="secondary"
                loading={regenerate.isMutating}
                disabled={!s.stepUpExpiresAt}
                onClick={() =>
                  void run(async () => {
                    const r = await regenerate.trigger(undefined);
                    if (r) setCodes(r.recoveryCodes);
                  })
                }
              >
                {t('recovery.regenerate')}
              </Button>
            </div>
          </section>

          <p className="text-content-muted text-sm">{t('lost')}</p>
        </>
      )}
    </div>
  );
}
