'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';

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

interface PageBody {
  data: { items: CaseItem[]; nextCursor: string | null };
}

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

async function errorCode(res: Response | null): Promise<string> {
  if (!res) return 'NETWORK';
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  const code = body?.error?.code ?? 'UNKNOWN';
  return KNOWN_ERRORS.has(code) ? code : 'UNKNOWN';
}

/** `sexual/minors` → `sexual_minors`: a message key cannot carry the slash. */
const categoryKey = (c: string) => c.replace(/[/-]/g, '_');

export function ModerationQueue() {
  const t = useTranslations('platform.moderation');
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<CaseItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(cursor: string | null) {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ reason: reason.trim() });
    if (cursor) qs.set('cursor', cursor);

    const res = await fetch(`/api/v1/platform/moderation/cases?${qs.toString()}`, {
      cache: 'no-store',
    }).catch(() => null);
    setLoading(false);

    if (!res?.ok) {
      setError(await errorCode(res));
      return;
    }
    const body = (await res.json()) as PageBody;
    setItems((prev) => (cursor && prev ? [...prev, ...body.data.items] : body.data.items));
    setNextCursor(body.data.nextCursor);
  }

  function resolved(caseId: string, elsewhere: boolean) {
    setItems((prev) => (prev ?? []).filter((i) => i.caseId !== caseId));
    setNotice(elsewhere ? t('resolvedElsewhere') : null);
  }

  const reasonReady = reason.trim().length >= MIN_REASON;

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-1.5 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (reasonReady) void load(null);
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
          <Button type="submit" disabled={!reasonReady || loading}>
            {items === null ? t('open') : t('refresh')}
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-content-error text-sm">
          {t(`error.${error}` as never)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-content-muted text-sm">
          {notice}
        </p>
      )}

      {items !== null &&
        (items.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : (
          <ul className="grid gap-4">
            {items.map((item) => (
              <CaseCard key={item.caseId} item={item} onResolved={resolved} />
            ))}
          </ul>
        ))}

      {nextCursor && (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={() => load(nextCursor)}
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
  onResolved,
}: {
  item: CaseItem;
  onResolved: (caseId: string, elsewhere: boolean) => void;
}) {
  const t = useTranslations('platform.moderation');
  const format = useFormatter();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteReady = note.trim().length >= MIN_REASON;
  const noteId = `note-${item.caseId}`;

  async function decide(decision: 'APPROVE' | 'REJECT') {
    setPending(true);
    setError(null);
    const res = await fetch(
      `/api/v1/platform/moderation/cases/${encodeURIComponent(item.caseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note: note.trim() }),
      },
    ).catch(() => null);
    setPending(false);

    // 409: another moderator decided it first. Either way it has left the
    // queue, and saying so beats leaving a card whose buttons can only fail.
    if (res?.ok || res?.status === 409) {
      onResolved(item.caseId, res.status === 409);
      return;
    }
    setError(await errorCode(res));
  }

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
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
        <p className="text-content-muted text-sm">{t('note.hint', { min: MIN_REASON })}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!noteReady || pending} onClick={() => decide('APPROVE')}>
            {t('approve')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!noteReady || pending}
            onClick={() => decide('REJECT')}
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
