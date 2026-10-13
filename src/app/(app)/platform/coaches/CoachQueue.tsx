'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { toCoachApplicationItem } from '@/app/api/v1/_lib/coach-dto';
import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { certificateSize } from '@/lib/coaches/certificate-limits';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type V1Page } from '@/lib/data/keys';
import { useViewerId } from '@/lib/data/provider';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR, useV1SWRInfinite } from '@/lib/data/use-v1-swr';

import { StepUpForm } from '../StepUpForm';

/**
 * The coaches' profiles sent for approval (#545; owner decisions 13 and 17).
 *
 * ═══ THE SAME DISCIPLINE AS THE MODERATION QUEUE ═══
 *
 * Every read and every decision goes to `/api/v1/platform/coaches/**`, where
 * the grant, COACH_APPROVE, the second factor and the audit row are checked
 * and written on every request. This component decides nothing about who may
 * see what.
 *
 * Every read is a record, so nothing reads on its own: the key stays null
 * until a reason is given, and focus, reconnect and stale-remount
 * revalidation are off (`audited`). Reads happen on "Show", "Show more" and
 * "Reload". A decision removes its card and does NOT re-read the list.
 *
 * COACH_APPROVE is a write capability, so the list needs a step-up as much as
 * a decision does. It is asked for up front when `GET /me/mfa` says this
 * session has none, and again whenever the API answers STEP_UP_REQUIRED.
 *
 * ═══ THE CERTIFICATE ═══
 *
 * One read of the list carries everything the owner reads to decide, except
 * the certificate itself, which is a personal document. It is fetched only
 * when "Download" is pressed, under the reason the list was opened with, and
 * handed to the browser as a file: it is never drawn on this page, and
 * nothing of it is kept here. A refusal (the step-up lapsed) is said on the
 * card, where a plain link would have saved the refusal as a file.
 */

/** The platform's own minimum; the API refuses anything shorter. */
const MIN_REASON = 12;
const TIME_ZONE = 'Europe/Sofia';

type Item = ReturnType<typeof toCoachApplicationItem>;
type Status = Item['status'];
type Decision = 'APPROVE' | 'DECLINE' | 'REMOVE';

const STATUSES: readonly Status[] = ['SUBMITTED', 'APPROVED', 'DECLINED'];

const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'INVALID_CURSOR',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'COACH_APPLICATION_NOT_FOUND',
  'COACH_HAS_UPCOMING_LESSONS',
  'NETWORK',
  'VIEWER_CHANGED',
  'STEP_UP_REQUIRED',
  'MFA_ENROLMENT_REQUIRED',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';
const needsStepUp = (e: unknown) => isApiClientError(e) && e.code === 'STEP_UP_REQUIRED';
/** Another admin decided it first, or the coach took it back: it has left this list. */
const decidedElsewhere = (e: unknown) =>
  isApiClientError(e) &&
  ((e.status === 409 && e.code === 'COACH_APPLICATION_STATE') ||
    (e.status === 404 && e.code === 'COACH_APPLICATION_NOT_FOUND'));

export function CoachQueue() {
  const t = useTranslations('platform.coaches');
  const tStepUp = useTranslations('platform.stepUp');
  const viewerId = useViewerId();
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<Status>('SUBMITTED');
  // What the list was opened with. Null until then, and so is the key.
  const [submitted, setSubmitted] = useState<{ reason: string; status: Status } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [stepUpAsked, setStepUpAsked] = useState(false);

  // Not audited, and decides nothing: it lets the page ask for the code
  // BEFORE the first read is refused.
  const mfa = useV1SWR<{ enrolled: boolean; stepUpExpiresAt: string | null }>(KEYS.mfaStatus());
  const notEnrolled = mfa.data?.enrolled === false;
  const showStepUp =
    !notEnrolled && (stepUpAsked || (mfa.data !== undefined && !mfa.data.stepUpExpiresAt));

  const getKey = useMemo(() => (submitted ? KEYS.coachApplications(submitted) : null), [submitted]);
  const list = useV1SWRInfinite<Item>(getKey, { audited: true });
  const { data, error, isValidating, setSize, mutate } = list;

  const decideMutation = useV1Mutation<
    { userId: string; decision: Decision; note: string },
    unknown,
    V1Page<Item>[]
  >({
    url: ({ userId }) => V1.decideCoach(userId),
    body: ({ decision, note }) => ({ decision, note }),
    target: getKey ? { infinite: mutate, getKey } : undefined,
    // Decided, so it has left the list it was read from.
    update: (pages, { userId }) =>
      pages.map((p) => ({ ...p, items: p.items.filter((i) => i.userId !== userId) })),
    fallback: [],
    // The list is not re-read after a decision: that read is an audit row.
    revalidate: false,
    keepOnError: decidedElsewhere,
  });

  const items = data ? data.flatMap((p) => p.items) : null;
  const nextCursor = data && data.length > 0 ? data[data.length - 1]!.nextCursor : null;
  const reasonReady = reason.trim().length >= MIN_REASON;

  async function open() {
    const next = { reason: reason.trim(), status };
    setNotice(null);
    setCardErrors({});
    if (next.reason !== submitted?.reason || next.status !== submitted.status) {
      setSubmitted(next);
      return;
    }
    // The same reason and list again is "Reload": back to page one, read once.
    await setSize(1);
    await mutate();
  }

  async function decide(userId: string, decision: Decision) {
    const note = (notes[userId] ?? '').trim();
    setNotice(null);
    setCardErrors(({ [userId]: _cleared, ...rest }) => rest);
    try {
      await decideMutation.trigger({ userId, decision, note });
      setNotes(({ [userId]: _done, ...rest }) => rest);
      setNotice(t(`done.${decision}`));
    } catch (e) {
      if (decidedElsewhere(e)) {
        setNotice(t('decidedElsewhere'));
        setNotes(({ [userId]: _gone, ...rest }) => rest);
        return;
      }
      if (needsStepUp(e)) setStepUpAsked(true);
      setCardErrors((prev) => ({ ...prev, [userId]: knownCode(e) }));
    }
  }

  /**
   * Fetch the certificate and hand it to the browser as a file. On a refusal
   * the answer is the API's error envelope, read for its code and said on the
   * card.
   */
  async function openCertificate(item: Item) {
    if (!submitted || !item.certificate) return;
    setOpening(item.userId);
    setCardErrors(({ [item.userId]: _cleared, ...rest }) => rest);
    try {
      const res = await fetch(V1.coachCertificateFile(item.userId, submitted.reason), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: viewerId ? { 'x-playerz-viewer': viewerId } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = body?.error?.code ?? 'UNKNOWN';
        if (code === 'STEP_UP_REQUIRED') setStepUpAsked(true);
        setCardErrors((prev) => ({
          ...prev,
          [item.userId]: KNOWN_ERRORS.has(code) ? code : 'UNKNOWN',
        }));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = item.certificate.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setCardErrors((prev) => ({ ...prev, [item.userId]: 'NETWORK' }));
    } finally {
      setOpening(null);
    }
  }

  async function stepped() {
    setStepUpAsked(false);
    setCardErrors({});
    void mfa.mutate();
    // The list was refused for want of a step-up: read it now, once.
    if (needsStepUp(error)) await mutate();
  }

  return (
    <div className="grid gap-6">
      {notEnrolled && (
        <InlineNotice variant="warning">
          {t('error.MFA_ENROLMENT_REQUIRED')}{' '}
          <Link href="/platform/security" className="underline">
            {tStepUp('enrolLink')}
          </Link>
        </InlineNotice>
      )}
      {(showStepUp || needsStepUp(error)) && <StepUpForm onStepped={() => void stepped()} />}

      {!notEnrolled && (
        <form
          className="grid gap-3 sm:max-w-xl"
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonReady) void open();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="coaches-reason">{t('reason.label')}</Label>
            <Input
              id="coaches-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={MIN_REASON}
              maxLength={500}
              autoComplete="off"
            />
            <p className="text-content-muted text-sm">{t('reason.hint', { min: MIN_REASON })}</p>
          </div>
          <ToggleGroup
            ariaLabel={t('statusLabel')}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            selected={status}
            selectAction={(v) => setStatus(v as Status)}
            className="self-start justify-self-start"
          />
          <div>
            <Button type="submit" disabled={!reasonReady || isValidating}>
              {items === null ? t('open') : t('refresh')}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <InlineNotice variant="error">{t(`error.${knownCode(error)}` as never)}</InlineNotice>
      )}
      {notice && (
        <p role="status" className="text-content-muted text-sm" data-testid="coaches-notice">
          {notice}
        </p>
      )}

      {submitted && needsSkeleton(list) && (
        <CardListSkeleton rows={3} lines={4} className="gap-4" />
      )}

      {items !== null &&
        (items.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : (
          <ul className="grid gap-4" data-testid="coaches-queue">
            {items.map((item) => (
              <CoachCard
                key={item.userId}
                item={item}
                note={notes[item.userId] ?? ''}
                onNote={(v) => setNotes((prev) => ({ ...prev, [item.userId]: v }))}
                error={cardErrors[item.userId] ?? null}
                opening={opening === item.userId}
                onOpenCertificate={() => void openCertificate(item)}
                onDecide={(decision) => void decide(item.userId, decision)}
              />
            ))}
          </ul>
        ))}

      {nextCursor && (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={isValidating}
            onClick={() => void setSize((n) => n + 1)}
          >
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}

function CoachCard({
  item,
  note,
  onNote,
  error,
  opening,
  onOpenCertificate,
  onDecide,
}: {
  item: Item;
  note: string;
  onNote: (note: string) => void;
  error: string | null;
  opening: boolean;
  onOpenCertificate: () => void;
  onDecide: (decision: Decision) => void;
}) {
  const t = useTranslations('platform.coaches');
  const tSports = useTranslations('sports');
  const format = useFormatter();

  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: TIME_ZONE,
    });
  const noteReady = note.trim().length >= MIN_REASON;
  const noteId = `coach-note-${item.userId}`;
  const decidable = item.status !== 'DECLINED';

  return (
    <li
      className="border-border-subtle bg-bg-default rounded-lg border p-4"
      data-testid="coach-card"
      data-coach={item.userId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-content-emphasis font-medium">{item.name?.trim() || t('noName')}</p>
        <p className="text-content-muted text-sm">
          {item.status === 'SUBMITTED'
            ? item.submittedAt && t('submitted', { when: when(item.submittedAt) })
            : item.decidedAt && t('decided', { when: when(item.decidedAt) })}
        </p>
      </div>

      <dl className="mt-3 grid gap-3 text-sm">
        <div>
          <dt className="text-content-muted text-xs font-medium">{t('sports')}</dt>
          <dd className="text-content-default">
            <ul>
              {item.sports.map((s) => (
                <li key={s.sport}>
                  {s.levelMin === s.levelMax
                    ? t('one', { sport: tSports(s.sport as never), level: s.levelMin })
                    : t('range', {
                        sport: tSports(s.sport as never),
                        min: s.levelMin,
                        max: s.levelMax,
                      })}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-content-muted text-xs font-medium">{t('bio')}</dt>
          <dd className="text-content-default whitespace-pre-wrap">{item.bio ?? t('none')}</dd>
        </div>
        <div>
          <dt className="text-content-muted text-xs font-medium">{t('qualifications')}</dt>
          <dd className="text-content-default whitespace-pre-wrap">
            {item.qualifications ?? t('none')}
          </dd>
        </div>
        {item.decisionNote ? (
          <div>
            <dt className="text-content-muted text-xs font-medium">{t('lastNote')}</dt>
            <dd className="text-content-default whitespace-pre-wrap">{item.decisionNote}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-content-muted text-xs font-medium">{t('certificate.title')}</dt>
          <dd className="text-content-default">
            {item.certificate ? (
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {t('certificate.info', {
                    name: item.certificate.fileName,
                    size: `${format.number(certificateSize(item.certificate.byteSize).value, {
                      maximumFractionDigits: 1,
                    })} ${certificateSize(item.certificate.byteSize).unit}`,
                    date: format.dateTime(new Date(item.certificate.uploadedAt), {
                      dateStyle: 'medium',
                      timeZone: TIME_ZONE,
                    }),
                  })}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={opening}
                  onClick={onOpenCertificate}
                  data-testid="coach-certificate-open"
                >
                  {opening ? t('certificate.opening') : t('certificate.open')}
                </Button>
              </div>
            ) : (
              t('certificate.none')
            )}
          </dd>
        </div>
      </dl>

      {decidable ? (
        <div className="border-border-subtle mt-4 grid gap-1.5 border-t pt-3">
          <Label htmlFor={noteId}>{t('note.label')}</Label>
          <Textarea
            id={noteId}
            rows={2}
            value={note}
            onChange={(e) => onNote(e.target.value)}
            maxLength={500}
          />
          <p className="text-content-muted text-sm">{t('note.hint', { min: MIN_REASON })}</p>
          <div className="flex flex-wrap gap-2">
            {/* No pending state: a decided card leaves the list at once, and
                comes back, enabled, only if the decision failed. */}
            {item.status === 'SUBMITTED' ? (
              <>
                <Button
                  type="button"
                  disabled={!noteReady}
                  onClick={() => onDecide('APPROVE')}
                  data-testid="coach-approve"
                >
                  {t('approve')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!noteReady}
                  onClick={() => onDecide('DECLINE')}
                  data-testid="coach-decline"
                >
                  {t('decline')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="destructive"
                disabled={!noteReady}
                onClick={() => onDecide('REMOVE')}
                data-testid="coach-remove"
              >
                {t('remove')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {error && (
        <InlineNotice variant="error" className="mt-3" data-testid="coach-card-error">
          {t(`error.${error}` as never)}
        </InlineNotice>
      )}
    </li>
  );
}
