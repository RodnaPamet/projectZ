'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { DrawDto, DrawMatchDto } from '@/app/api/v1/_lib/tournament-dto';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';

type Entry = NonNullable<DrawMatchDto['sideA']>;

/**
 * A tournament's draw (#580): the groups, each with its table (57) and its
 * matches, then the knockout round by round and the match for third (61).
 * Each match says where it stands: waiting, on a court and when, played and
 * the score, or a walkover. `actions` puts the club's buttons on a match.
 */
export function DrawView({
  draw,
  actions,
  linkMyMatches = false,
}: {
  draw: DrawDto;
  actions?: (m: DrawMatchDto) => ReactNode;
  /** A player's own match on a court links to its booking, where the result is reported. */
  linkMyMatches?: boolean;
}) {
  const t = useTranslations('tournaments.draw');
  const tCommon = useTranslations('common');

  const name = (e: Entry | null) =>
    !e
      ? t('tbd')
      : e.players
          .map((p) => (p.deleted ? tCommon('deletedUser') : (p.name ?? t('unnamed'))))
          .join(' / ') + (e.withdrawn ? ` (${t('withdrawn')})` : '');
  const rounds = draw.knockout.length;
  const roundName = (i: number) => {
    const fromEnd = rounds - 1 - i;
    return fromEnd === 0
      ? t('final')
      : fromEnd === 1
        ? t('semis')
        : fromEnd === 2
          ? t('quarters')
          : t('round', { n: i + 1 });
  };

  return (
    <div className="gap-section flex flex-col" data-testid="draw">
      {draw.groups.map((g) => (
        <section
          key={g.groupNo}
          className="gap-compact flex flex-col"
          aria-labelledby={`draw-group-${g.groupNo}`}
        >
          <Heading level={3} className="text-base" id={`draw-group-${g.groupNo}`}>
            {draw.groups.length > 1
              ? t('group', { letter: String.fromCharCode(64 + g.groupNo) })
              : t('table')}
          </Heading>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="draw-table">
              <thead>
                <tr className="text-content-muted text-left">
                  <th scope="col" className="w-8 py-1 font-normal">
                    #
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    {t('entry')}
                  </th>
                  {(['played', 'won', 'drawn', 'lost', 'points'] as const).map((k) => (
                    <th key={k} scope="col" className="w-10 py-1 text-right font-normal">
                      <abbr title={t(`col.${k}`)}>{t(`colShort.${k}`)}</abbr>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.table.map((r) => (
                  <tr key={r.entryId} className="border-border-subtle border-t">
                    <td className="py-1 tabular-nums">{r.rank}</td>
                    <th scope="row" className="py-1 text-left font-normal">
                      {name(r.entry)}
                    </th>
                    <td className="py-1 text-right tabular-nums">{r.played}</td>
                    <td className="py-1 text-right tabular-nums">{r.won}</td>
                    <td className="py-1 text-right tabular-nums">{r.drawn}</td>
                    <td className="py-1 text-right tabular-nums">{r.lost}</td>
                    <td className="text-content-emphasis py-1 text-right font-semibold tabular-nums">
                      {r.points}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="gap-tight flex flex-col">
            {g.matches.map((m) => (
              <li key={m.id}>
                <MatchCard match={m} name={name} actions={actions} linkMine={linkMyMatches} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {draw.knockout.map((round, i) => (
        <section key={i} className="gap-compact flex flex-col" aria-labelledby={`draw-round-${i}`}>
          <Heading level={3} className="text-base" id={`draw-round-${i}`}>
            {roundName(i)}
          </Heading>
          <ul className="grid gap-3 sm:grid-cols-2">
            {round.map((m) => (
              <li key={m.id}>
                <MatchCard match={m} name={name} actions={actions} linkMine={linkMyMatches} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {draw.thirdPlace ? (
        <section className="gap-compact flex flex-col" aria-labelledby="draw-third">
          <Heading level={3} className="text-base" id="draw-third">
            {t('thirdPlace')}
          </Heading>
          <MatchCard
            match={draw.thirdPlace}
            name={name}
            actions={actions}
            linkMine={linkMyMatches}
          />
        </section>
      ) : null}
    </div>
  );
}

function MatchCard({
  match: m,
  name,
  actions,
  linkMine,
}: {
  match: DrawMatchDto;
  name: (e: Entry | null) => string;
  actions?: (m: DrawMatchDto) => ReactNode;
  linkMine: boolean;
}) {
  const t = useTranslations('tournaments.draw');
  const format = useFormatter();
  const bye = m.status === 'WALKOVER' && (!m.sideA || !m.sideB);
  const side = (i: 0 | 1) => {
    const e = i === 0 ? m.sideA : m.sideB;
    const won = m.winnerSide === i;
    return (
      <div
        className={cn(
          'flex items-center justify-between gap-3',
          won ? 'text-content-emphasis font-semibold' : 'text-content-default',
        )}
      >
        <span className="min-w-0 truncate">{e ? name(e) : bye ? t('bye') : t('tbd')}</span>
        {m.score ? (
          <span className="shrink-0 tabular-nums">{m.score.map((pair) => pair[i]).join(' ')}</span>
        ) : null}
      </div>
    );
  };
  const when = m.scheduled
    ? format.dateTime(new Date(m.scheduled.startTs), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <Card
      elevation="flat"
      className={cn('gap-tight flex flex-col text-sm', m.mine && 'ring-2 ring-[var(--ring)]')}
      data-testid="draw-match"
    >
      {side(0)}
      {side(1)}
      <div className="flex flex-wrap items-center gap-2">
        {m.status === 'WALKOVER' && !bye ? (
          <StatusBadge variant="neutral" icon={null}>
            {t('walkover')}
          </StatusBadge>
        ) : null}
        {m.status === 'READY' && m.scheduled ? (
          <Caption data-testid="draw-match-scheduled">
            {t('scheduled', { when: when!, court: m.scheduled.courtName })}
          </Caption>
        ) : m.status === 'READY' ? (
          <Caption>{t('notScheduled')}</Caption>
        ) : null}
        {linkMine && m.mine && m.scheduled && m.status === 'READY' ? (
          <Link
            href={`/me/bookings/${encodeURIComponent(m.scheduled.bookingId)}`}
            className="text-content-emphasis text-sm underline underline-offset-4"
            data-testid="draw-match-booking"
          >
            {t('toBooking')}
          </Link>
        ) : null}
      </div>
      {actions ? actions(m) : null}
    </Card>
  );
}
