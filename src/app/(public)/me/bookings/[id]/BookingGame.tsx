'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { BookingGameDto, OpenGameRequestDto } from '@/app/api/v1/_lib/open-play-dto';
import { REQUEST_TONE } from '@/components/games/GameCard';
import { openPlayErrorKey, type OpenPlayErrorKey } from '@/components/games/game-copy';
import { useLevelWish } from '@/components/games/use-level-wish';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { Msgs } from '@/components/ui/icons/nucleo/msgs';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { useLevelLabel } from '@/components/profile/use-level-label';
import { KEYS, keysUnder, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { conversationPath } from '@/lib/messaging/paths';

import { bookingPlayerReads } from './BookingPlayers';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);
const OpenGameDialog = dynamic(() => import('./OpenGameDialog').then((m) => m.OpenGameDialog));

/**
 * Open play on a booking (#376). For the booker: «Търся играчи», then what the
 * game asks for, the requests with each asker's public card (name, picture,
 * sports and levels — the card messaging shows, #375), and accept / decline.
 * An accepted player joins the players above as any added player does. For a
 * player who joined through Игри: until when they can pull out.
 */
export function BookingGame({ bookingId, seed }: { bookingId: string; seed: BookingGameDto }) {
  const t = useTranslations('myBookings.game');
  const tGames = useTranslations('games');
  const tCard = useTranslations('games.card');
  const levelWish = useLevelWish();
  const format = useFormatter();
  // Re-read each minute: the answer buttons go when the club's cutoff passes.
  const now = useNow({ updateInterval: 60_000 });
  const [editing, setEditing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<OpenPlayErrorKey | null>(null);

  const key = KEYS.meBookingGame(bookingId);
  const { data, mutate } = useV1SWR<BookingGameDto>(key, { fallbackData: seed });
  const view = data ?? seed;
  // Accepting or removing changes who plays: the players card re-reads too.
  const related = bookingPlayerReads(bookingId);

  const answer = useV1Mutation<{ id: string; verb: 'accept' | 'decline' }, BookingGameDto>({
    url: ({ id, verb }) => V1.answerGameRequest(bookingId, id, verb),
    related: { keys: keysUnder(KEYS.meBooking(bookingId)), infinite: related.infinite },
  });
  const close = useV1Mutation<void, BookingGameDto>({
    url: () => V1.bookingGame(bookingId),
    method: 'DELETE',
  });

  const deadline = format.dateTime(new Date(view.cutoffAt), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const beforeCutoff = new Date(view.cutoffAt).getTime() > now.getTime();

  async function respond(r: OpenGameRequestDto, verb: 'accept' | 'decline') {
    setError(null);
    try {
      const next = await answer.trigger({ id: r.id, verb });
      if (next) void mutate(next, { revalidate: false });
    } catch (e) {
      setError(openPlayErrorKey(e));
      void mutate();
    }
  }

  async function stop() {
    setError(null);
    try {
      const next = await close.trigger();
      if (next) void mutate(next, { revalidate: false });
    } catch (e) {
      setError(openPlayErrorKey(e));
    }
  }

  const chat = view.chatId ? (
    <Link
      href={conversationPath({ kind: 'me' }, view.chatId)}
      className={buttonVariants({ variant: 'secondary' })}
      data-testid="booking-game-chat"
    >
      <Msgs className="size-4" aria-hidden="true" />
      {t('chat')}
    </Link>
  ) : null;

  if (view.viewerRole === 'PARTICIPANT') {
    if (view.myRequest?.status !== 'ACCEPTED') return null;
    return (
      <section className="gap-tight flex flex-col" data-testid="booking-game-joined">
        <InlineNotice variant="info">
          {beforeCutoff ? t('joined', { deadline }) : t('joinedSettled')}
        </InlineNotice>
        {chat ? <div className="flex">{chat}</div> : null}
      </section>
    );
  }

  const g = view.game;
  if (!g && !view.canOpen) return null;
  const pending = view.requests.filter((r) => r.status === 'PENDING');
  const others = view.requests.filter((r) => r.status !== 'PENDING');

  return (
    <section className="gap-tight flex flex-col" aria-labelledby="booking-game">
      <Heading level={2} tone="muted" className="text-sm" id="booking-game">
        {t('heading')}
      </Heading>

      <Card elevation="flat" className="gap-default flex flex-col" data-testid="booking-game">
        {g ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                variant={g.open ? 'success' : 'neutral'}
                data-testid="booking-game-state"
              >
                {g.closedAt
                  ? t('state.closed')
                  : g.open
                    ? t('state.open')
                    : g.spotsLeft === 0
                      ? t('state.full')
                      : t('state.cutoff')}
              </StatusBadge>
              {g.open ? (
                <StatusBadge variant="neutral" icon={null}>
                  {tCard('spotsLeft', { count: g.spotsLeft })}
                </StatusBadge>
              ) : null}
              <StatusBadge variant="neutral" icon={null}>
                {levelWish(g.levelMin, g.levelMax)}
              </StatusBadge>
            </div>
            {g.note ? (
              <p className="text-content-default text-sm break-words whitespace-pre-wrap">
                {g.note}
              </p>
            ) : null}
            {beforeCutoff ? <Caption>{t('answerUntil', { deadline })}</Caption> : null}
            <div className="flex flex-wrap gap-2">
              {chat}
              {view.canOpen ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditing(true)}
                  data-testid="booking-game-edit"
                >
                  {g.closedAt ? t('reopen') : t('edit')}
                </Button>
              ) : null}
              {!g.closedAt && beforeCutoff ? (
                <Button
                  type="button"
                  variant="ghost"
                  loading={close.isMutating}
                  onClick={() => setStopping(true)}
                  data-testid="booking-game-stop"
                >
                  {t('stop')}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <p className="text-content-default text-sm">{t('intro')}</p>
            <Button
              type="button"
              className="self-start"
              onClick={() => setEditing(true)}
              data-testid="booking-game-open"
            >
              {t('open')}
            </Button>
          </>
        )}
      </Card>

      {error ? (
        <InlineNotice variant="error" data-testid="booking-game-error">
          {t(`error.${error}`)}
        </InlineNotice>
      ) : null}

      {g ? (
        <div className="gap-tight flex flex-col" data-testid="booking-game-requests">
          <div className="flex items-baseline justify-between gap-3">
            <Heading level={3} tone="muted" className="text-sm">
              {t('requests')}
            </Heading>
            {pending.length > 0 ? (
              <Caption>{t('waiting', { count: pending.length })}</Caption>
            ) : null}
          </div>
          {view.requests.length === 0 ? (
            <Caption>{t('noRequests')}</Caption>
          ) : (
            <Card elevation="flat" density="none">
              <ul className="divide-border-subtle divide-y">
                {[...pending, ...others].map((r) => (
                  <RequestRow
                    key={r.id}
                    request={r}
                    statusLabel={tGames(`status.${r.status}`)}
                    busy={answer.isMutating}
                    canAnswer={beforeCutoff}
                    onAnswer={(verb) => void respond(r, verb)}
                  />
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : null}

      {editing ? (
        <OpenGameDialog
          bookingId={bookingId}
          view={view}
          deadline={deadline}
          open={editing}
          setOpen={setEditing}
          onSaved={(next) => void mutate(next, { revalidate: false })}
        />
      ) : null}
      {stopping ? (
        <ConfirmDialog
          showModal={stopping}
          setShowModal={setStopping}
          title={t('stopConfirm.title')}
          description={t('stopConfirm.description')}
          confirmLabel={t('stopConfirm.yes')}
          cancelLabel={t('stopConfirm.no')}
          onConfirm={() => void stop()}
        />
      ) : null}
    </section>
  );
}

function RequestRow({
  request: r,
  statusLabel,
  busy,
  canAnswer,
  onAnswer,
}: {
  request: OpenGameRequestDto;
  statusLabel: string;
  busy: boolean;
  canAnswer: boolean;
  onAnswer: (verb: 'accept' | 'decline') => void;
}) {
  const t = useTranslations('myBookings.game');
  const tCommon = useTranslations('common');
  const tSports = useTranslations('sports');
  const levelLabel = useLevelLabel();
  const name = r.player.deleted ? tCommon('deletedUser') : (r.player.name ?? t('unnamed'));

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="booking-game-request">
      <div className="flex items-start gap-3">
        <InitialsAvatar value={name} imageUrl={r.player.avatarUrl} size="md" />
        <div className="min-w-0 flex-1">
          <span className="text-content-emphasis block truncate text-sm font-medium">{name}</span>
          {r.player.sports.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1" aria-label={t('sports')}>
              {r.player.sports.map((s) => (
                <li key={s.sport}>
                  <StatusBadge variant="neutral" icon={null}>
                    {tSports(s.sport as never)} · {levelLabel(s)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {r.status !== 'PENDING' ? (
          <StatusBadge variant={REQUEST_TONE[r.status]} className="shrink-0">
            {statusLabel}
          </StatusBadge>
        ) : null}
      </div>
      {r.note ? (
        <p className="text-content-default text-sm break-words whitespace-pre-wrap">„{r.note}“</p>
      ) : null}
      {r.status === 'PENDING' && canAnswer ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onAnswer('accept')}
            aria-label={t('acceptLabel', { name })}
            data-testid="booking-game-accept"
          >
            {t('accept')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAnswer('decline')}
            aria-label={t('declineLabel', { name })}
            data-testid="booking-game-decline"
          >
            {t('decline')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
