'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { BookingPlayerDto, MyBookingDetailDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Caption, Heading } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, keysUnder, V1, type InfiniteKey } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

import { BOOKING_LIST_KEYS } from '../MyBookingsList';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);
// The sheet, its share button and the co-player list are drawn only when the
// booker opens it: most visits to a booking never invite anybody.
const InvitePlayersSheet = dynamic(() =>
  import('./InvitePlayersSheet').then((m) => m.InvitePlayersSheet),
);

/** A refusal from a players route, as a catalogue key under `myBookings.players.error`. */
export type PlayersErrorKey = 'FULL' | 'CLOSED' | 'TOO_MANY' | 'FAILED';

export function playersErrorKey(e: unknown): PlayersErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  if (e.code === 'BOOKING_FULL') return 'FULL';
  if (e.code === 'BOOKING_PLAYERS_CLOSED') return 'CLOSED';
  if (e.code === 'TOO_MANY_INVITE_LINKS') return 'TOO_MANY';
  return 'FAILED';
}

/** Every read that shows who is on this booking, refreshed after a change. */
export function bookingPlayerReads(bookingId: string) {
  return {
    keys: keysUnder(KEYS.meBooking(bookingId)),
    infinite: [
      BOOKING_LIST_KEYS.upcoming as InfiniteKey<unknown>,
      BOOKING_LIST_KEYS.past as InfiniteKey<unknown>,
    ],
  };
}

/**
 * "Играчи" on the booking detail (#358): who is playing, and what the caller
 * may do about it.
 *
 *   booker, before the start   "Покани играчи" (a sheet: share a link, or add
 *                              somebody they have played with) and Премахни
 *                              on each added player
 *   added player, before it    Напусни играта, on their own row
 *   anyone, after the start    the list, and nothing to press
 *
 * Names and avatars only: the DTO carries no email, phone or user id for
 * anybody. Removing and leaving ask first (ConfirmDialog), then refresh the
 * booking, its players and both tabs of the list. Leaving takes the caller
 * back to Резервации, since the booking is no longer theirs to open.
 */
export function BookingPlayers({
  booking: b,
  date,
  time,
}: {
  booking: MyBookingDetailDto;
  /** The game's date and start, in the venue's zone, for the share text. */
  date: string;
  time: string;
}) {
  const t = useTranslations('myBookings.players');
  const td = useTranslations('myBookings.detail');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<BookingPlayerDto | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<PlayersErrorKey | null>(null);

  const isBooker = b.viewerRole === 'BOOKER';
  const related = bookingPlayerReads(b.id);

  const remove = useV1Mutation<{ participantId: string }>({
    url: ({ participantId }) => V1.removeBookingPlayer(b.id, participantId),
    method: 'DELETE',
    related,
  });
  const leave = useV1Mutation<void>({
    url: () => V1.leaveBooking(b.id),
    method: 'DELETE',
    related: { infinite: related.infinite },
  });

  async function confirmRemove(p: BookingPlayerDto) {
    if (!p.participantId) return;
    setError(null);
    try {
      await remove.trigger({ participantId: p.participantId });
    } catch (e) {
      setError(playersErrorKey(e));
    }
  }

  async function confirmLeave() {
    setError(null);
    try {
      await leave.trigger();
      router.push('/me/bookings');
    } catch (e) {
      setError(playersErrorKey(e));
    }
  }

  // A player who deleted their account (#370) keeps the place, under no name.
  const label = (p: BookingPlayerDto) =>
    p.deleted ? tCommon('deletedUser') : (p.name ?? td('unnamed'));
  const name = (p: BookingPlayerDto) => (p.isYou ? td('you') : label(p));

  return (
    <section className="gap-tight flex flex-col" aria-labelledby="booking-players">
      <div className="flex items-baseline justify-between gap-3">
        <Heading level={2} tone="muted" className="text-sm" id="booking-players">
          {td('players')}
        </Heading>
        <Caption data-testid="booking-spots-left">{t('spotsLeft', { count: b.spotsLeft })}</Caption>
      </div>

      <Card elevation="flat" density="none">
        <ul className="divide-border-subtle divide-y" data-testid="booking-players">
          {b.players.map((p, i) => (
            <li
              key={p.participantId ?? `booker-${i}`}
              className="flex min-h-14 items-center gap-3 px-4 py-2"
            >
              <InitialsAvatar value={label(p)} imageUrl={p.avatarUrl} />
              <span className="text-content-default min-w-0 flex-1 truncate text-sm">
                {name(p)}
              </span>
              {p.isBooker ? (
                <Caption className="shrink-0">{td('booker')}</Caption>
              ) : !p.registered ? (
                <Caption className="shrink-0">{td('guest')}</Caption>
              ) : null}
              {b.playersOpen && isBooker && !p.isBooker && p.participantId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  aria-label={t('removeLabel', { name: name(p) })}
                  onClick={() => {
                    setRemoving(p);
                    setRemoveOpen(true);
                  }}
                  data-testid="booking-player-remove"
                >
                  {t('remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {error ? (
        <InlineNotice variant="error" data-testid="booking-players-error">
          {t(`error.${error}`)}
        </InlineNotice>
      ) : null}

      {b.playersOpen && isBooker ? (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => setInviting(true)}
          data-testid="booking-invite-open"
        >
          {t('invite')}
        </Button>
      ) : null}

      {b.playersOpen && !isBooker ? (
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          loading={leave.isMutating}
          onClick={() => setLeaving(true)}
          data-testid="booking-leave"
        >
          {t('leave')}
        </Button>
      ) : null}

      {!b.playersOpen && b.status !== 'CANCELLED' && b.players.length > 1 ? (
        <Caption>{t('closed')}</Caption>
      ) : null}

      {inviting ? (
        <InvitePlayersSheet
          booking={b}
          date={date}
          time={time}
          open={inviting}
          onOpenChange={setInviting}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          showModal={removeOpen}
          setShowModal={setRemoveOpen}
          tone="danger"
          title={t('removeConfirm.title', { name: name(removing) })}
          description={t('removeConfirm.description')}
          confirmLabel={t('removeConfirm.yes')}
          cancelLabel={t('removeConfirm.no')}
          onConfirm={() => void confirmRemove(removing)}
        />
      ) : null}

      {leaving ? (
        <ConfirmDialog
          showModal={leaving}
          setShowModal={setLeaving}
          tone="danger"
          title={t('leaveConfirm.title')}
          description={t('leaveConfirm.description')}
          confirmLabel={t('leaveConfirm.yes')}
          cancelLabel={t('leaveConfirm.no')}
          onConfirm={() => void confirmLeave()}
        />
      ) : null}
    </section>
  );
}
