'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ConversationDto, MessageDto } from '@/app/api/v1/_lib/messaging';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useEnterSubmit } from '@/components/ui/hooks';
import { ChevronLeft, Flag, PaperPlane } from '@/components/ui/icons/nucleo';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Textarea } from '@/components/ui/textarea';
import { Caption, Heading } from '@/components/ui/typography';
import type { ApiClientError } from '@/lib/data/errors';
import { v1Fetch } from '@/lib/data/fetcher';
import { KEYS, V1, type InboxSide } from '@/lib/data/keys';
import { useViewerId } from '@/lib/data/provider';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { CONVERSATION_REFRESH_MS, MAX_BODY_LENGTH } from '@/lib/messaging/limits';
import type { ReportReason } from '@/lib/messaging/report';

import { ReportDialog } from './ReportDialog';

/**
 * One conversation, oldest message at the top (#375), ported from Agrent's
 * `ThreadClient`.
 *
 * ═══ WHY POLLING, AND NOT A SOCKET ═══
 *
 * There is no broker: the use case persists and never publishes, so the
 * transport is this screen's concern. While it is open and visible it re-reads
 * the newest page every 5 seconds (SWR pauses in a hidden tab), against one
 * capped, indexed read. When a push transport lands, this file changes and
 * nothing behind it does.
 *
 * ═══ OLDER PAGES LIVE HERE, NOT IN THE CACHE ═══
 *
 * The poll replaces the newest page every 5 seconds. Scrollback kept in the
 * same cache entry would be thrown away on every tick, so older pages
 * accumulate in this component's state.
 *
 * ═══ MARKING READ ═══
 *
 * Whenever the newest message from the other side changes while the screen is
 * visible — on opening, and when the poll brings something new. The endpoint
 * is monotonic, so two tabs or a slow answer cannot rewind it; that is why
 * nothing here coordinates.
 *
 * ═══ BLOCK AND REPORT ═══
 *
 * «Блокирай» stops new messages both ways, as Agrent's does: with a player it
 * blocks the PERSON (the blocked one loses sight of the conversation, and is
 * not told); in a club conversation it blocks that conversation, until the
 * side that pressed it lifts it. No confirmation: it is undone from the same
 * button. «Сигнал» sends a message, or the whole conversation, to the
 * platform's moderators (`ReportDialog`).
 *
 * ═══ ONE SCREEN, BOTH INBOXES ═══
 *
 * A player's conversation and a club's are the same screen: `side` says which
 * API it talks to (`/me` or the club's admin). The server decides what the
 * caller may do (`state`, `canSend`) and refuses anything else on its own.
 */

type State = ConversationDto['state'];

export interface ConversationViewProps {
  side: InboxSide;
  seed: ConversationDto;
  back: { href: string; label: string };
  /** Where the counterpart's name leads: a club's public page. Null: plain text. */
  counterpartHref?: string | null;
}

/** The optimistic row a send shows until the poll brings the real one. */
function pendingMessage(id: string, body: string): MessageDto {
  return {
    id: `pending-${id}`,
    mine: true,
    fromClub: false,
    sender: { name: null, deleted: false, clubName: null },
    body,
    deleted: false,
    createdAt: new Date().toISOString(),
  };
}

/** Within 120 px of the end counts as reading the end. */
function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

export function ConversationView({ side, seed, back, counterpartHref }: ConversationViewProps) {
  const t = useTranslations('messaging.conversation');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const viewerId = useViewerId();

  const key = KEYS.conversation(side, seed.id);
  const unreadKey = KEYS.conversationsUnread(side);
  const { data } = useV1SWR<ConversationDto>(key, {
    fallbackData: seed,
    refreshInterval: CONVERSATION_REFRESH_MS,
  });
  const c = data ?? seed;

  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [retracting, setRetracting] = useState<MessageDto | null>(null);
  const [retractOpen, setRetractOpen] = useState(false);
  const [older, setOlder] = useState<MessageDto[]>([]);
  // `undefined` = not walked yet, DISTINCT from `null` = reached the start.
  // Derived rather than seeded in an effect: seeding on every poll would bring
  // back a cursor already walked past.
  const [walkedCursor, setWalkedCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // What the report dialog is about, and a fresh key for each opening.
  const [reporting, setReporting] = useState<{ messageId: string | null; key: number } | null>(
    null,
  );
  const [reportOpen, setReportOpen] = useState(false);
  const [blockError, setBlockError] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const related = {
    keys: (k: unknown) => k === unreadKey,
    infinite: [KEYS.conversations(side), KEYS.conversations(side, { tab: 'requests' })],
  };

  const markRead = useV1Mutation<void>({
    url: () => V1.markConversationRead(side, seed.id),
    revalidate: false,
    related,
  });

  const send = useV1Mutation<{ body: string }, unknown, ConversationDto>({
    url: () => V1.sendMessage(side, seed.id),
    body: ({ body }) => ({ body }),
    target: { key },
    update: (visible, { body }, { id }) => ({
      ...visible,
      messages: [...visible.messages, pendingMessage(id, body)],
    }),
    fallback: seed,
    related,
  });

  const retract = useV1Mutation<{ messageId: string }, unknown, ConversationDto>({
    url: ({ messageId }) => V1.retractMessage(side, messageId),
    method: 'DELETE',
    target: { key },
    update: (visible, { messageId }) => ({
      ...visible,
      messages: visible.messages.map((m) =>
        m.id === messageId ? { ...m, body: null, deleted: true } : m,
      ),
    }),
    fallback: seed,
  });

  const block = useV1Mutation<void, unknown, ConversationDto>({
    url: () => V1.blockConversation(side, seed.id),
    method: 'POST',
    target: { key },
    update: (visible) => ({ ...visible, state: 'blocked', blockedByMe: true, canSend: false }),
    fallback: seed,
    related,
  });
  const unblock = useV1Mutation<void, unknown, ConversationDto>({
    url: () => V1.blockConversation(side, seed.id),
    method: 'DELETE',
    target: { key },
    update: (visible) => ({ ...visible, state: 'active', blockedByMe: false, canSend: true }),
    fallback: seed,
    related,
  });

  const report = useV1Mutation<{ messageId: string | null; reason: ReportReason; details: string }>(
    {
      url: ({ messageId }) =>
        messageId ? V1.reportMessage(side, messageId) : V1.reportConversation(side, seed.id),
      body: ({ reason, details }) => (details ? { reason, details } : { reason }),
      revalidate: false,
    },
  );

  const openReport = (messageId: string | null) => {
    setReporting((prev) => ({ messageId, key: (prev?.key ?? 0) + 1 }));
    setReportOpen(true);
  };

  const respond = useV1Mutation<{ accept: boolean }, unknown, ConversationDto>({
    url: ({ accept }) => (accept ? V1.acceptRequest(seed.id) : V1.declineRequest(seed.id)),
    target: { key },
    update: (visible, { accept }) => ({
      ...visible,
      state: accept ? 'active' : 'declined',
      canSend: true,
    }),
    fallback: seed,
    related,
  });

  // ── Read ──
  const newestTheirs = [...c.messages].reverse().find((m) => !m.mine)?.id ?? null;
  const trigger = markRead.trigger;
  useEffect(() => {
    if (!newestTheirs || document.visibilityState !== 'visible') return;
    // A failure is swallowed: an unmarked conversation shows as unread, a
    // safer wrong answer than an error on a screen nobody asked to write to.
    trigger().catch(() => undefined);
  }, [newestTheirs, trigger]);

  // ── Scroll: follow the end while the reader is at it ──
  // From `md` the list scrolls inside the shell; on a phone the page does, so
  // the end is brought into view by whichever of them scrolls.
  const count = c.messages.length;
  useLayoutEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);

  const olderCursor = walkedCursor === undefined ? c.olderCursor : walkedCursor;
  const loadOlder = useCallback(async () => {
    if (!olderCursor) return;
    setLoadingOlder(true);
    try {
      const page = await v1Fetch<ConversationDto>(
        KEYS.conversation(side, seed.id, { before: olderCursor }),
        { viewerId },
      );
      stick.current = false;
      setOlder((prev) => [...page.messages, ...prev]);
      setWalkedCursor(page.olderCursor);
    } catch {
      // Silent: the reader still has everything they had a moment ago.
    } finally {
      setLoadingOlder(false);
    }
  }, [olderCursor, side, seed.id, viewerId]);

  // ── Send ──
  const submit = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    setSendError(null);
    stick.current = true;
    // Cleared at once, and put back on a refusal: what the person wrote is
    // never lost to a dropped connection.
    setDraft('');
    send.trigger({ body }).catch((err: ApiClientError) => {
      setDraft(body);
      setSendError(err.code ?? 'UNKNOWN');
    });
  }, [draft, send]);

  // Cmd/Ctrl+Enter sends, a bare Enter breaks the line; the hook also waits
  // out an open IME candidate window, so Cyrillic composed through a dead-key
  // chain never fires half-typed.
  const { handleKeyDown } = useEnterSubmit({ onSubmit: submit });

  const messages = [...older, ...c.messages];
  const counterpartName =
    c.counterpart.kind === 'club'
      ? c.counterpart.name
      : c.counterpart.deleted
        ? tCommon('deletedUser')
        : (c.counterpart.name ?? t('unnamed'));
  const avatarUrl = c.counterpart.kind === 'player' ? c.counterpart.avatarUrl : null;
  const tooLong = draft.trim().length > MAX_BODY_LENGTH;

  return (
    <div
      data-perf-ready
      className="in-shell:p-0 mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-4 max-md:min-h-[calc(100dvh-4rem)] md:px-6 md:py-8"
      data-testid="conversation"
    >
      <Link
        href={back.href}
        className="text-content-muted hover:text-content-emphasis inline-flex min-h-11 items-center gap-1 self-start text-sm transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {back.label}
      </Link>

      <div className="border-border-subtle flex items-center gap-3 border-b pb-3">
        <InitialsAvatar value={counterpartName} imageUrl={avatarUrl} size="md" />
        <div className="min-w-0">
          <Heading level={1} className="truncate text-xl" data-testid="conversation-title">
            {counterpartHref ? (
              <Link href={counterpartHref} className="underline-offset-4 hover:underline">
                {counterpartName}
              </Link>
            ) : (
              counterpartName
            )}
          </Heading>
          <Caption>{c.counterpart.kind === 'club' ? t('kindClub') : t('kindPlayer')}</Caption>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
          {c.state === 'blocked' && c.blockedByMe ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setBlockError(false);
                unblock.trigger().catch(() => setBlockError(true));
              }}
              data-testid="conversation-unblock"
            >
              {t('unblock')}
            </Button>
          ) : c.state !== 'blocked' && c.state !== 'closed' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setBlockError(false);
                block.trigger().catch(() => setBlockError(true));
              }}
              data-testid="conversation-block"
            >
              {t('block')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<Flag aria-hidden="true" />}
            onClick={() => openReport(null)}
            data-testid="conversation-report"
          >
            {t('report')}
          </Button>
        </div>
      </div>
      {blockError ? (
        <InlineNotice variant="error" className="mt-2" data-testid="conversation-block-error">
          {t('blockFailed')}
        </InlineNotice>
      ) : null}

      <div
        ref={listRef}
        onScroll={(e) => {
          stick.current = nearBottom(e.currentTarget);
        }}
        className="gap-compact flex min-h-0 flex-1 flex-col overflow-y-auto py-4"
        data-testid="conversation-messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {olderCursor ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-center"
            loading={loadingOlder}
            onClick={() => void loadOlder()}
            data-testid="conversation-older"
          >
            {t('older')}
          </Button>
        ) : null}

        {messages.length === 0 ? (
          <Caption className="self-center py-8" data-testid="conversation-empty">
            {t('empty')}
          </Caption>
        ) : (
          messages.map((m) => (
            <Bubble
              key={m.id}
              m={m}
              sender={senderLabel(m, side, {
                you: t('you'),
                deleted: tCommon('deletedUser'),
                unnamed: t('unnamed'),
              })}
              time={format.dateTime(new Date(m.createdAt), {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
              deletedLabel={t('deleted')}
              removeLabel={t('remove')}
              reportLabel={t('reportMessage')}
              onReport={
                // Somebody else's line — and for a club, not a colleague's.
                !m.mine && !m.deleted && !(side.kind === 'club' && m.fromClub)
                  ? () => openReport(m.id)
                  : null
              }
              onRemove={
                m.mine && !m.deleted && !m.id.startsWith('pending-')
                  ? (target) => {
                      setRetracting(target);
                      setRetractOpen(true);
                    }
                  : null
              }
            />
          ))
        )}
        <div ref={endRef} className="scroll-mb-28" aria-hidden="true" />
      </div>

      <StateNotice
        state={c.state}
        canSend={c.canSend}
        blockedByMe={c.blockedByMe}
        name={counterpartName}
      />

      {c.state === 'request' ? (
        <div className="flex flex-wrap gap-2 pb-3" data-testid="conversation-request-actions">
          <Button
            type="button"
            loading={respond.isMutating}
            onClick={() => void respond.trigger({ accept: true }).catch(() => undefined)}
            data-testid="conversation-accept"
          >
            {t('accept')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={respond.isMutating}
            onClick={() => void respond.trigger({ accept: false }).catch(() => undefined)}
            data-testid="conversation-decline"
          >
            {t('decline')}
          </Button>
        </div>
      ) : null}

      {c.canSend ? (
        <form
          className="border-border-subtle bg-bg-page flex items-end gap-2 border-t pt-3 max-md:sticky max-md:bottom-0 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          data-testid="conversation-composer"
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            rows={2}
            className="flex-1"
            invalid={tooLong}
            data-testid="conversation-input"
          />
          <Button
            type="submit"
            icon={<PaperPlane aria-hidden="true" />}
            disabled={draft.trim() === '' || tooLong}
            data-testid="conversation-send"
          >
            {t('send')}
          </Button>
        </form>
      ) : null}

      {tooLong ? (
        <InlineNotice variant="error" className="mt-2">
          {t('tooLong', { max: MAX_BODY_LENGTH })}
        </InlineNotice>
      ) : null}
      {sendError ? (
        <InlineNotice variant="error" className="mt-2" data-testid="conversation-send-error">
          {t(`sendError.${SEND_ERRORS.includes(sendError) ? sendError : 'UNKNOWN'}`)}
        </InlineNotice>
      ) : null}

      {reporting ? (
        <ReportDialog
          key={reporting.key}
          open={reportOpen}
          setOpen={setReportOpen}
          subject={reporting.messageId ? 'message' : 'conversation'}
          onSubmit={({ reason, details }) =>
            report.trigger({ messageId: reporting.messageId, reason, details })
          }
        />
      ) : null}

      {retracting ? (
        <ConfirmDialog
          showModal={retractOpen}
          setShowModal={setRetractOpen}
          tone="danger"
          title={t('removeConfirm.title')}
          description={t('removeConfirm.description')}
          confirmLabel={t('removeConfirm.yes')}
          cancelLabel={t('removeConfirm.no')}
          onConfirm={() => {
            setRetractOpen(false);
            void retract.trigger({ messageId: retracting.id }).catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** The refusals a person can do something about; anything else is UNKNOWN. */
const SEND_ERRORS = [
  'REQUEST_PENDING',
  'CONVERSATION_BLOCKED',
  'RECIPIENT_GONE',
  'RATE_LIMITED',
  'MESSAGE_TOO_LONG',
  'CONVERSATION_NOT_FOUND',
];

/** Who wrote it, as the reader sees it: «Вие», a name, and the club a staff reply was for. */
function senderLabel(
  m: MessageDto,
  side: InboxSide,
  words: { you: string; deleted: string; unnamed: string },
): string {
  if (m.mine) return words.you;
  const name = m.sender.deleted ? words.deleted : (m.sender.name ?? words.unnamed);
  // A player reads «Иван · Тенис клуб Левски»; the club's own staff know
  // which club they are in, and read the colleague's name alone.
  return m.sender.clubName && side.kind === 'me' ? `${name} · ${m.sender.clubName}` : name;
}

function Bubble({
  m,
  sender,
  time,
  deletedLabel,
  removeLabel,
  onRemove,
  reportLabel,
  onReport,
}: {
  m: MessageDto;
  sender: string;
  time: string;
  deletedLabel: string;
  removeLabel: string;
  onRemove: ((m: MessageDto) => void) | null;
  reportLabel: string;
  onReport: (() => void) | null;
}) {
  return (
    <div
      className={`flex max-w-[85%] flex-col gap-1 ${m.mine ? 'items-end self-end' : 'items-start self-start'}`}
      data-testid="conversation-message"
      data-mine={m.mine ? 'true' : 'false'}
    >
      <Caption className="flex flex-wrap items-center gap-x-2">
        <span>{sender}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={m.createdAt}>{time}</time>
      </Caption>
      <div
        className={`rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap ${
          m.mine
            ? 'bg-bg-subtle text-content-emphasis'
            : 'border-border-subtle text-content-emphasis border'
        } ${m.deleted ? 'text-content-muted italic' : ''}`}
      >
        {m.deleted ? deletedLabel : m.body}
      </div>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRemove(m)}
          data-testid="conversation-remove"
        >
          {removeLabel}
        </Button>
      ) : null}
      {onReport ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReport}
          data-testid="conversation-report-message"
        >
          {reportLabel}
        </Button>
      ) : null}
    </div>
  );
}

function StateNotice({
  state,
  canSend,
  blockedByMe,
  name,
}: {
  state: State;
  canSend: boolean;
  blockedByMe: boolean;
  name: string;
}) {
  const t = useTranslations('messaging.conversation');
  let key: string | null = null;
  if (state === 'request') key = 'request';
  else if (state === 'pending') key = canSend ? 'firstIsRequest' : 'pending';
  else if (state === 'declined') key = 'declined';
  else if (state === 'blocked') key = blockedByMe ? 'blockedByMe' : 'blocked';
  else if (state === 'closed') key = 'closed';
  if (!key) return null;
  return (
    <InlineNotice
      variant={state === 'blocked' || state === 'closed' ? 'warning' : 'info'}
      className="mb-3"
      data-testid={`conversation-notice-${key}`}
    >
      {t(`notice.${key}`, { name })}
    </InlineNotice>
  );
}
