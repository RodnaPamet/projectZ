'use client';

import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type V1Page } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWRInfinite } from '@/lib/data/use-v1-swr';

/**
 * The review moderation queue.
 *
 * ═══ IT CALLS THE PLATFORM API, AND HOLDS NOTHING ITSELF ═══
 *
 * Every read and every decision goes to `/api/v1/platform/moderation/**`, where
 * the grant, the REVIEW_MODERATE capability and the audit row are checked and
 * written on every request. The same-origin session cookie is the credential;
 * this component decides nothing about who may see what. Someone without a
 * grant gets the refusal the API gives, said plainly.
 *
 * ═══ WHY IT ASKS FOR A REASON BEFORE SHOWING ANYTHING ═══
 *
 * Every platform read is recorded with the reason the reader gave, and the
 * server will not invent one — a reason the server wrote reads like the
 * moderator's own statement and is not. So the moderator states it once, for
 * this session of work, and it goes with every page they load. Each decision
 * carries its own note, which is both the audit reason and the answer to
 * "why was my review taken down?".
 *
 * ═══ EVERY READ HERE IS A RECORD, SO NOTHING READS ON ITS OWN ═══
 *
 * It is the client data layer's first consumer (src/lib/data), as an AUDITED
 * cursor list: the key stays null until a reason is submitted, and focus,
 * reconnect, stale remounts, retries and the first-page re-check on load-more
 * are all off — each would be a PLATFORM_MODERATION_QUEUE_READ row the
 * moderator did not ask for. Reads happen on "Open", "Show more" (exactly one
 * page) and "Refresh" (back to page one, one read).
 *
 * A decision removes its card optimistically and does NOT re-read the queue.
 * CASE_ALREADY_RESOLVED keeps it removed with the "resolved elsewhere" notice —
 * it has left the queue either way. Any other failure puts the card back and
 * says why on the card. Notes and per-card errors live HERE, not in the card:
 * the card unmounts the moment it is removed, and a rolled-back card is a new
 * instance that would otherwise come back with the moderator's note erased.
 */

/** The platform's own minimum; the API refuses anything shorter. */
const MIN_REASON = 12;

/**
 * The zone "in the queue since" is told in — stated, not left to the runtime.
 *
 * next-intl is configured with no time zone, so an unzoned `dateTime` falls
 * back to the browser's and reports ENVIRONMENT_FALLBACK on every card. The
 * cases come from clubs in Bulgaria and every club defaults to Europe/Sofia,
 * so the queue reads in the same clock as the reviews it is about.
 */
const QUEUE_TIME_ZONE = 'Europe/Sofia';

interface CaseItem {
  caseId: string;
  reason: string;
  openedAt: string;
  scores: Record<string, number>;
  review: { id: string; rating: number; body: string | null; status: string; createdAt: string };
  venue: { id: string; name: string };
  club: { id: string; slug: string; name: string };
}

type Decision = 'APPROVE' | 'REJECT';

/** Error codes the UI has words for. Anything else reads as UNKNOWN. */
const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'INVALID_CURSOR',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'CASE_NOT_FOUND',
  'NETWORK',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';

const resolvedElsewhere = (e: unknown) =>
  isApiClientError(e) && e.status === 409 && e.code === 'CASE_ALREADY_RESOLVED';

/** `sexual/minors` → `sexual_minors`: a message key cannot carry the slash. */
const categoryKey = (c: string) => c.replace(/[/-]/g, '_');

export function ModerationQueue() {
  const t = useTranslations('platform.moderation');
  const [reason, setReason] = useState('');
  // The reason the list was opened with. Null until then — and so is the key.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  const getKey = useMemo(
    () => (submitted ? KEYS.moderationCases({ reason: submitted }) : null),
    [submitted],
  );
  const list = useV1SWRInfinite<CaseItem>(getKey, { audited: true });
  const { data, error, isValidating, setSize, mutate } = list;

  const resolve = useV1Mutation<
    { caseId: string; decision: Decision; note: string },
    unknown,
    V1Page<CaseItem>[]
  >({
    url: ({ caseId }) => V1.resolveCase(caseId),
    body: ({ decision, note }) => ({ decision, note }),
    target: getKey ? { infinite: mutate, getKey } : undefined,
    update: (pages, { caseId }) =>
      pages.map((p) => ({ ...p, items: p.items.filter((i) => i.caseId !== caseId) })),
    fallback: [],
    // The queue is not re-read after a decision: that read is an audit row.
    revalidate: false,
    keepOnError: resolvedElsewhere,
  });

  const items = data ? data.flatMap((p) => p.items) : null;
  const nextCursor = data && data.length > 0 ? data[data.length - 1]!.nextCursor : null;
  const reasonReady = reason.trim().length >= MIN_REASON;

  async function open() {
    const r = reason.trim();
    setNotice(null);
    if (r !== submitted) {
      setSubmitted(r);
      return;
    }
    // The same reason again is "Refresh": back to page one, read once.
    await setSize(1);
    await mutate();
  }

  async function decide(caseId: string, decision: Decision) {
    const note = (notes[caseId] ?? '').trim();
    setNotice(null);
    setCardErrors(({ [caseId]: _cleared, ...rest }) => rest);
    try {
      await resolve.trigger({ caseId, decision, note });
      setNotes(({ [caseId]: _done, ...rest }) => rest);
    } catch (e) {
      // 409: another moderator decided it first. It has left the queue either
      // way, and saying so beats a card whose buttons can only fail.
      if (resolvedElsewhere(e)) {
        setNotice(t('resolvedElsewhere'));
        setNotes(({ [caseId]: _gone, ...rest }) => rest);
        return;
      }
      setCardErrors((prev) => ({ ...prev, [caseId]: knownCode(e) }));
    }
  }

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-1.5 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (reasonReady) void open();
        }}
      >
        <Label htmlFor="moderation-reason">{t('reason.label')}</Label>
        <Input
          id="moderation-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={MIN_REASON}
          maxLength={500}
          autoComplete="off"
        />
        <p className="text-content-muted text-sm">{t('reason.hint', { min: MIN_REASON })}</p>
        <div>
          <Button type="submit" disabled={!reasonReady || isValidating}>
            {items === null ? t('open') : t('refresh')}
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-content-error text-sm">
          {t(`error.${knownCode(error)}` as never)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-content-muted text-sm">
          {notice}
        </p>
      )}

      {submitted && needsSkeleton(list) && (
        <CardListSkeleton rows={3} lines={3} className="gap-4" />
      )}

      {items !== null &&
        (items.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : (
          <ul className="grid gap-4">
            {items.map((item) => (
              <CaseCard
                key={item.caseId}
                item={item}
                note={notes[item.caseId] ?? ''}
                onNote={(v) => setNotes((prev) => ({ ...prev, [item.caseId]: v }))}
                error={cardErrors[item.caseId] ?? null}
                onDecide={(decision) => void decide(item.caseId, decision)}
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

function CaseCard({
  item,
  note,
  onNote,
  error,
  onDecide,
}: {
  item: CaseItem;
  note: string;
  onNote: (note: string) => void;
  error: string | null;
  onDecide: (decision: Decision) => void;
}) {
  const t = useTranslations('platform.moderation');
  const format = useFormatter();

  const noteReady = note.trim().length >= MIN_REASON;
  const noteId = `note-${item.caseId}`;

  const scores = Object.entries(item.scores).sort(([, a], [, b]) => b - a);
  const flagged = item.reason.startsWith('classifier_') || item.reason === 'user_report';

  return (
    <li className="border-border-subtle bg-bg-default rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-content-emphasis font-medium">{item.venue.name}</p>
          <p className="text-content-muted text-sm">
            {item.club.name} ·{' '}
            {t('opened', {
              when: format.dateTime(new Date(item.openedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: QUEUE_TIME_ZONE,
              }),
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge variant="warning">
            {flagged
              ? t(`flag.${item.reason}` as never)
              : t('flag.category', {
                  category: t(`category.${categoryKey(item.reason)}` as never),
                })}
          </StatusBadge>
          <StatusBadge variant="neutral">
            {t(`reviewStatus.${item.review.status}` as never)}
          </StatusBadge>
        </div>
      </div>

      <p className="text-content-default mt-3 text-sm">
        {t('rating', { rating: item.review.rating })}
      </p>
      {item.review.body ? (
        <blockquote className="border-border-subtle text-content-default mt-2 border-l-2 pl-3 text-sm whitespace-pre-wrap">
          {item.review.body}
        </blockquote>
      ) : (
        <p className="text-content-muted mt-2 text-sm">{t('noText')}</p>
      )}

      <div className="mt-3">
        <p className="text-content-muted text-xs font-medium">{t('scores.title')}</p>
        {scores.length === 0 ? (
          <p className="text-content-muted text-sm">{t('scores.none')}</p>
        ) : (
          <ul className="mt-1 grid gap-0.5 text-sm sm:grid-cols-2">
            {scores.map(([category, score]) => (
              <li key={category} className="flex justify-between gap-3 tabular-nums">
                <span>{t(`category.${categoryKey(category)}` as never)}</span>
                <span className="text-content-muted">
                  {format.number(score, { style: 'percent' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

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
          {/* No pending state: a decided card leaves the list at once, and only
              comes back — enabled — if the decision failed. */}
          <Button type="button" disabled={!noteReady} onClick={() => onDecide('APPROVE')}>
            {t('approve')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!noteReady}
            onClick={() => onDecide('REJECT')}
          >
            {t('reject')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-content-error text-sm">
            {t(`error.${error}` as never)}
          </p>
        )}
      </div>
    </li>
  );
}
