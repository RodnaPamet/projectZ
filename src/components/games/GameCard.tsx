'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { OpenGameDto, OpenGameRequestStatusDto } from '@/app/api/v1/_lib/open-play-dto';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

import { openPlayErrorKey, type OpenPlayErrorKey } from './game-copy';
import { useLevelWish } from './use-level-wish';

const AskDialog = dynamic(() => import('./AskDialog').then((m) => m.AskDialog));

export const REQUEST_TONE: Record<
  OpenGameRequestStatusDto,
  'neutral' | 'info' | 'success' | 'warning' | 'error'
> = {
  PENDING: 'info',
  ACCEPTED: 'success',
  DECLINED: 'error',
  REMOVED: 'error',
  WITHDRAWN: 'neutral',
  LEFT: 'neutral',
  LAPSED: 'warning',
  CLOSED: 'neutral',
};

/** States after which a player may ask the same game again. */
const MAY_ASK_AGAIN: ReadonlySet<OpenGameRequestStatusDto> = new Set([
  'WITHDRAWN',
  'LEFT',
  'LAPSED',
  'CLOSED',
]);

/**
 * One open game (#376), as Игри, the venue page and «Моите заявки» show it:
 * sport, time at the venue, where, how many more players, the booker's level
 * wish and note, and the one thing the viewer can do — ask, withdraw, go to
 * their booking, or sign in to ask.
 */
export function GameCard({
  game,
  signInHref,
  showVenue = true,
  status,
  onChanged,
}: {
  game: OpenGameDto;
  /** Where a signed-out visitor goes to ask: the sign-in page, back here after. */
  signInHref: string;
  /** The venue's name and link; off on the venue's own page. */
  showVenue?: boolean;
  /** «Моите заявки»: the request's state, shown even once the game is not listed. */
  status?: OpenGameRequestStatusDto;
  onChanged?: (game: OpenGameDto | null) => void;
}) {
  const t = useTranslations('games.card');
  const tGames = useTranslations('games');
  const tSports = useTranslations('sports');
  const levelWish = useLevelWish();
  const format = useFormatter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<OpenPlayErrorKey | null>(null);

  const timeZone = game.timezone;
  const date = format.dateTime(new Date(game.startTs), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  const time = format.dateTime(new Date(game.startTs), { timeStyle: 'short', timeZone });
  const until = format.dateTime(new Date(game.endTs), { timeStyle: 'short', timeZone });

  const viewer = game.viewer;
  const request = viewer?.request ?? null;
  const shownStatus = status ?? request?.status ?? null;

  const withdraw = useV1Mutation<{ id: string }>({
    url: ({ id }) => V1.withdrawGameRequest(id),
    method: 'DELETE',
  });

  async function confirmWithdraw() {
    if (!request) return;
    setError(null);
    try {
      await withdraw.trigger({ id: request.id });
      onChanged?.(null);
    } catch (e) {
      setError(openPlayErrorKey(e));
    }
  }

  const canAsk =
    game.open &&
    !!viewer &&
    !viewer.isPlaying &&
    (request === null || MAY_ASK_AGAIN.has(request.status));

  return (
    <Card
      elevation="flat"
      className="gap-default flex flex-col"
      data-testid="game-card"
      data-game-id={game.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading level={3} className="text-base">
            {tSports(game.sport as never)} · {date}, {time}–{until}
          </Heading>
          <Caption className="block">
            {showVenue ? (
              <>
                <Link
                  href={`/venues/${encodeURIComponent(game.venue.slug)}`}
                  className="text-content-emphasis underline-offset-4 hover:underline"
                >
                  {game.venue.name}
                </Link>
                {' · '}
              </>
            ) : null}
            {game.courtName}
          </Caption>
        </div>
        {shownStatus ? (
          <StatusBadge
            variant={REQUEST_TONE[shownStatus]}
            className="shrink-0"
            data-testid="game-request-status"
          >
            {tGames(`status.${shownStatus}`)}
          </StatusBadge>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {game.open ? (
          <StatusBadge variant="success" icon={null}>
            {t('spotsLeft', { count: game.spotsLeft })}
          </StatusBadge>
        ) : null}
        <StatusBadge variant="neutral" icon={null}>
          {levelWish(game.levelMin, game.levelMax)}
        </StatusBadge>
      </div>

      {game.note ? (
        <p className="text-content-default text-sm break-words whitespace-pre-wrap">{game.note}</p>
      ) : null}

      <div className="flex items-center gap-2">
        <InitialsAvatar
          value={game.booker.firstName ?? t('organiserUnknown')}
          imageUrl={game.booker.avatarUrl}
          size="sm"
        />
        <Caption>
          {game.booker.firstName
            ? t('organiser', { name: game.booker.firstName })
            : t('organiserUnknown')}
          {' · '}
          {t('players', { count: game.playersCount, capacity: game.capacity })}
        </Caption>
      </div>

      {error ? (
        <InlineNotice variant="error" data-testid="game-error">
          {tGames(`error.${error}`)}
        </InlineNotice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {viewer === null && game.open ? (
          <Link
            href={signInHref}
            className={buttonVariants({ variant: 'primary' })}
            data-testid="game-sign-in"
          >
            {t('signIn')}
          </Link>
        ) : null}
        {viewer?.isPlaying && viewer.bookingId ? (
          <Link
            href={`/me/bookings/${encodeURIComponent(viewer.bookingId)}`}
            className={buttonVariants({ variant: 'secondary' })}
            data-testid="game-booking"
          >
            {viewer.isBooker ? t('manage') : t('toBooking')}
          </Link>
        ) : null}
        {canAsk ? (
          <Button type="button" onClick={() => setAsking(true)} data-testid="game-ask">
            {t('ask')}
          </Button>
        ) : null}
        {request?.status === 'PENDING' ? (
          <Button
            type="button"
            variant="ghost"
            loading={withdraw.isMutating}
            onClick={() => void confirmWithdraw()}
            data-testid="game-withdraw"
          >
            {t('withdraw')}
          </Button>
        ) : null}
      </div>

      {asking ? (
        <AskDialog
          game={game}
          when={{ date, time }}
          open={asking}
          setOpen={setAsking}
          onAsked={(updated) => onChanged?.(updated)}
        />
      ) : null}
    </Card>
  );
}
