'use client';

import { useFormatter, useTranslations } from 'next-intl';

import type { TournamentDto } from '@/app/api/v1/_lib/tournament-dto';

/**
 * How a tournament reads in a list or on its page (#579): its format, singles
 * or doubles, when, the fee and how it is paid, and the places.
 */
export function useTournamentLabels() {
  const t = useTranslations('tournaments');
  const tSports = useTranslations('sports');
  const format = useFormatter();

  const when = (iso: string) =>
    format.dateTime(new Date(iso), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  return {
    /** «Падел · Елиминации · Двойки» */
    kind: (x: Pick<TournamentDto, 'sport' | 'format' | 'teamSize'>) =>
      [
        tSports(x.sport as never),
        t(`format.${x.format}`),
        x.teamSize === 2 ? t('doubles') : t('singles'),
      ].join(' · '),
    when,
    /** «пт, 30 окт., 10:00 – нд, 1 ное.» */
    dates: (x: Pick<TournamentDto, 'startsAt' | 'endsAt'>) =>
      x.endsAt ? t('dates', { from: when(x.startsAt), to: when(x.endsAt) }) : when(x.startsAt),
    fee: (x: Pick<TournamentDto, 'entryFeeCents' | 'feePayment'>) =>
      x.entryFeeCents === 0
        ? t('free')
        : t(x.feePayment === 'ONLINE' ? 'feeOnline' : 'feeAtClub', {
            fee: format.number(x.entryFeeCents / 100, { style: 'currency', currency: 'EUR' }),
          }),
    places: (x: Pick<TournamentDto, 'confirmed' | 'drawSize' | 'teamSize'>) =>
      t(x.teamSize === 2 ? 'placesPairs' : 'places', { confirmed: x.confirmed, size: x.drawSize }),
    status: (x: Pick<TournamentDto, 'status' | 'entriesOpen'>) =>
      x.status === 'REGISTRATION' && !x.entriesOpen ? t('status.CLOSED') : t(`status.${x.status}`),
  };
}
