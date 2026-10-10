'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type V1Page } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR, useV1SWRInfinite } from '@/lib/data/use-v1-swr';

import { StepUpForm } from '../StepUpForm';

/**
 * The moderation queue: reviews, and (#375) reported messages and
 * conversations, oldest first.
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
 *
 * ═══ EVERY READ AND DECISION NEEDS A STEP-UP (#262) ═══
 *
 * REVIEW_MODERATE is a write capability, and every write capability needs a
 * second-factor step-up on the session from the last 15 minutes — reading the
 * queue included. The queue asks for it up front when `GET /me/mfa` says this
 * session has none (that read is not audited), and again whenever the API
 * answers STEP_UP_REQUIRED, because the window can close mid-sitting. A
 * decision refused that way keeps its card and its note; the moderator types a
 * code and presses the button again. Nothing is retried on their behalf.
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

interface ReviewCaseItem {
  subject: 'REVIEW';
  caseId: string;
  reason: string;
  openedAt: string;
  scores: Record<string, number>;
  review: { id: string; rating: number; body: string | null; status: string; createdAt: string };
  venue: { id: string; name: string };
  club: { id: string; slug: string; name: string };
}

/** A reported message or conversation (#375). */
interface ChatCaseItem {
  subject: 'CHAT_MESSAGE' | 'CONVERSATION';
  caseId: string;
  reason: string;
  openedAt: string;
  conversation: {
    id: string;
    kind: 'player' | 'club';
    club: { name: string } | null;
    closed: boolean;
  };
  messages: Array<{
    id: string;
    from: { name: string | null; deleted: boolean; clubName: string | null };
    body: string | null;
    deleted: boolean;
    createdAt: string;
    reported: boolean;
  }>;
  reports: Array<{ reason: string; at: string }>;
}

type CaseItem = ReviewCaseItem | ChatCaseItem;

const isChatCase = (item: CaseItem): item is ChatCaseItem =>
  item.subject === 'CHAT_MESSAGE' || item.subject === 'CONVERSATION';

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
  // The tab was rendered for another account (#263). The app-wide notice says
  // so too; without a key here the queue said "something went wrong".
  'VIEWER_CHANGED',
  // The second factor (#262): a code is needed, or enrolment first.
  'STEP_UP_REQUIRED',
  'MFA_ENROLMENT_REQUIRED',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';

const needsStepUp = (e: unknown) => isApiClientError(e) && e.code === 'STEP_UP_REQUIRED';

const resolvedElsewhere = (e: unknown) =>
  isApiClientError(e) && e.status === 409 && e.code === 'CASE_ALREADY_RESOLVED';

/** `sexual/minors` → `sexual_minors`: a message key cannot carry the slash. */
const categoryKey = (c: string) => c.replace(/[/-]/g, '_');

export function ModerationQueue() {
  const t = useTranslations('platform.moderation');
  const tStepUp = useTranslations('platform.stepUp');
  const [reason, setReason] = useState('');
  // The reason the list was opened with. Null until then — and so is the key.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  // Set when the API said STEP_UP_REQUIRED; cleared when a code is accepted.
  const [stepUpAsked, setStepUpAsked] = useState(false);

  // Not audited, and decides nothing: it only lets the queue ask for the code
  // BEFORE the first read is refused. The binding is what enforces it.
  const mfa = useV1SWR<{ enrolled: boolean; stepUpExpiresAt: string | null }>(KEYS.mfaStatus());
  const notEnrolled = mfa.data?.enrolled === false;
  const showStepUp =
    !notEnrolled && (stepUpAsked || (mfa.data !== undefined && !mfa.data.stepUpExpiresAt));

  const getKey = useMemo(
    () => (submitted ? KEYS.moderationCases({ reason: submitted }) : null),
    [submitted],
  );
  const list = useV1SWRInfinite<CaseItem>(getKey, { audited: true });
  const { data, error, isValidating, setSize, mutate } = list;

  const resolve = useV1Mutation<
    { caseId: string; subject: CaseItem['subject']; decision: Decision; note: string },
    unknown,
    V1Page<CaseItem>[]
  >({
    // A review's decision moves a venue's rating; a message's does not, and has
    // its own route so the audit row names it (#375).
    url: ({ caseId, subject }) =>
      subject === 'CHAT_MESSAGE' || subject === 'CONVERSATION'
        ? V1.resolveMessageCase(caseId)
        : V1.resolveCase(caseId),
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

  async function decide(caseId: string, subject: CaseItem['subject'], decision: Decision) {
    const note = (notes[caseId] ?? '').trim();
    setNotice(null);
    setCardErrors(({ [caseId]: _cleared, ...rest }) => rest);
    try {
      await resolve.trigger({ caseId, subject, decision, note });
      setNotes(({ [caseId]: _done, ...rest }) => rest);
    } catch (e) {
      // 409: another moderator decided it first. It has left the queue either
      // way, and saying so beats a card whose buttons can only fail.
      if (resolvedElsewhere(e)) {
        setNotice(t('resolvedElsewhere'));
        setNotes(({ [caseId]: _gone, ...rest }) => rest);
        return;
      }
      if (needsStepUp(e)) setStepUpAsked(true);
      setCardErrors((prev) => ({ ...prev, [caseId]: knownCode(e) }));
    }
  }

  async function stepped() {
    setStepUpAsked(false);
    setCardErrors({});
    void mfa.mutate();
    // The list was refused for want of a step-up: read it again now, which is
    // the read the moderator asked for when they opened it. ONE read: a refused
    // first page leaves the size at 1, and `setSize(1)` as well would fetch
    // that page a second time — another audit row (measured in the rendered
    // test, which counts them).
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

      {/* Not before a second factor exists (audit M04): a reason field and a
          greyed "open" button under the enrolment notice read as a form that
          is broken, when nothing it could send would be accepted. */}
      {!notEnrolled && (
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
      )}

      {error && (
        <InlineNotice variant="error">{t(`error.${knownCode(error)}` as never)}</InlineNotice>
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
            {items.map((item) =>
              !isChatCase(item) ? (
                <CaseCard
                  key={item.caseId}
                  item={item}
                  note={notes[item.caseId] ?? ''}
                  onNote={(v) => setNotes((prev) => ({ ...prev, [item.caseId]: v }))}
                  error={cardErrors[item.caseId] ?? null}
                  onDecide={(decision) => void decide(item.caseId, item.subject, decision)}
                />
              ) : (
                <ChatCaseCard
                  key={item.caseId}
                  item={item}
                  note={notes[item.caseId] ?? ''}
                  onNote={(v) => setNotes((prev) => ({ ...prev, [item.caseId]: v }))}
                  error={cardErrors[item.caseId] ?? null}
                  onDecide={(decision) => void decide(item.caseId, item.subject, decision)}
                />
              ),
            )}
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
  item: ReviewCaseItem;
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
        {error && <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>}
      </div>
    </li>
  );
}

/** `abuse — what they said` → the category, and the reporter's words. */
function splitReport(reason: string): { category: string; words: string | null } {
  const at = reason.indexOf(' — ');
  return at < 0
    ? { category: reason, words: null }
    : { category: reason.slice(0, at), words: reason.slice(at + 3) };
}

const REPORT_CATEGORIES = new Set(['spam', 'abuse', 'inappropriate', 'other']);

/**
 * A reported message or conversation (#375): the conversation's latest lines
 * with the reported one marked, who wrote each, and what the reports said —
 * never who reported. «Остави» keeps it; «Премахни» removes the message, or
 * closes the conversation for both sides.
 */
function ChatCaseCard({
  item,
  note,
  onNote,
  error,
  onDecide,
}: {
  item: ChatCaseItem;
  note: string;
  onNote: (note: string) => void;
  error: string | null;
  onDecide: (decision: Decision) => void;
}) {
  const t = useTranslations('platform.moderation');
  const tChat = useTranslations('platform.moderation.chat');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const noteReady = note.trim().length >= MIN_REASON;
  const noteId = `note-${item.caseId}`;
  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: QUEUE_TIME_ZONE,
    });

  return (
    <li
      className="border-border-subtle bg-bg-default rounded-lg border p-4"
      data-testid="moderation-chat-case"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-content-emphasis font-medium">
            {item.subject === 'CHAT_MESSAGE' ? tChat('titleMessage') : tChat('titleConversation')}
          </p>
          <p className="text-content-muted text-sm">
            {item.conversation.kind === 'club' && item.conversation.club
              ? tChat('withClub', { club: item.conversation.club.name })
              : tChat('betweenPlayers')}{' '}
            · {t('opened', { when: when(item.openedAt) })}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge variant="warning">{t('flag.user_report')}</StatusBadge>
          {item.conversation.closed ? (
            <StatusBadge variant="neutral">{tChat('closed')}</StatusBadge>
          ) : null}
        </div>
      </div>

      <ul className="mt-3 grid gap-1" aria-label={tChat('reportsLabel')}>
        {item.reports.map((r, i) => {
          const { category, words } = splitReport(r.reason);
          return (
            <li key={i} className="text-content-default text-sm">
              <span className="font-medium">
                {REPORT_CATEGORIES.has(category)
                  ? tChat(`reason.${category}` as never)
                  : tChat('reason.other')}
              </span>
              {words ? <span className="text-content-muted"> — {words}</span> : null}
            </li>
          );
        })}
      </ul>

      <ol
        className="border-border-subtle mt-3 grid max-h-80 gap-2 overflow-y-auto border-l-2 pl-3"
        aria-label={tChat('contextLabel')}
      >
        {item.messages.map((m) => (
          <li
            key={m.id}
            className={m.reported ? 'bg-bg-warning rounded-md p-2' : ''}
            data-reported={m.reported ? 'true' : undefined}
          >
            <p className="text-content-muted text-xs">
              {m.from.deleted ? tCommon('deletedUser') : (m.from.name ?? tChat('unnamed'))}
              {m.from.clubName ? ` · ${m.from.clubName}` : ''} · {when(m.createdAt)}
              {m.reported ? ` · ${tChat('reported')}` : ''}
            </p>
            <p
              className={`text-sm whitespace-pre-wrap ${m.deleted ? 'text-content-muted italic' : 'text-content-default'}`}
            >
              {m.deleted ? tChat('deleted') : m.body}
            </p>
          </li>
        ))}
      </ol>

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
          <Button type="button" disabled={!noteReady} onClick={() => onDecide('APPROVE')}>
            {tChat('keep')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!noteReady}
            onClick={() => onDecide('REJECT')}
          >
            {item.subject === 'CHAT_MESSAGE' ? tChat('removeMessage') : tChat('closeConversation')}
          </Button>
        </div>
        {error && <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>}
      </div>
    </li>
  );
}
