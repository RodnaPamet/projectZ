'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { ClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import {
  tournamentErrorKey,
  type TournamentErrorKey,
} from '@/components/tournaments/tournament-errors';
import { useTournamentLabels } from '@/components/tournaments/use-tournament-labels';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { TournamentForm, type TournamentFormValue } from '../TournamentForm';
import { AdminDraw } from './AdminDraw';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

type Entry = ClubTournamentDto['entries'][number];

const ENTRY_TONE: Record<Entry['status'], 'success' | 'info' | 'neutral' | 'warning'> = {
  CONFIRMED: 'success',
  PENDING: 'info',
  DECLINED: 'neutral',
  WITHDRAWN: 'neutral',
};

/**
 * One of the club's tournaments (#579): open sign-up, change it, cancel it,
 * and confirm the entries in sign-up order up to the draw size (38); those
 * past it wait in order (51), and a place freed lets the next in.
 */
export function AdminTournamentDetail({
  slug,
  seed,
  venues,
}: {
  slug: string;
  seed: ClubTournamentDto;
  venues: Array<{
    id: string;
    name: string;
    sports: string[];
    courts: Array<{ id: string; name: string }>;
  }>;
}) {
  const t = useTranslations('admin.tournaments');
  const tT = useTranslations('tournaments');
  const tCommon = useTranslations('common');
  const l = useTournamentLabels();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<TournamentErrorKey | null>(null);
  const { data, mutate } = useV1SWR<ClubTournamentDto>(KEYS.clubTournament(slug, seed.id), {
    fallbackData: seed,
  });
  const x = data ?? seed;

  const act = useV1Mutation<'open' | 'cancel', ClubTournamentDto>({
    url: (a) => V1.tournamentAction(slug, x.id, a),
  });
  const decide = useV1Mutation<{ id: string; verb: 'confirm' | 'decline' }, ClubTournamentDto>({
    url: ({ id, verb }) => V1.decideTournamentEntry(slug, id, verb),
  });
  // A tournament under way (#580, 59): the club withdraws an entry.
  const withdraw = useV1Mutation<{ id: string }, ClubTournamentDto>({
    url: ({ id }) => V1.withdrawTournamentEntryAsClub(slug, id),
  });
  const update = useV1Mutation<TournamentFormValue, ClubTournamentDto>({
    url: () => V1.updateTournament(slug, x.id),
    method: 'PUT',
    body: (v) => v,
  });

  async function run<T>(fn: () => Promise<T | undefined>) {
    setError(null);
    try {
      const next = await fn();
      if (next) void mutate(next as unknown as ClubTournamentDto, { revalidate: false });
      return true;
    } catch (e) {
      setError(tournamentErrorKey(e));
      void mutate();
      return false;
    }
  }

  const person = (p: Entry['player'] | null) =>
    !p ? '' : p.deleted ? tCommon('deletedUser') : (p.name ?? tT('unnamed'));
  const changeable = x.status === 'DRAFT' || x.status === 'REGISTRATION';
  const confirmed = x.entries.filter((e) => e.status === 'CONFIRMED');
  const pending = x.entries.filter((e) => e.status === 'PENDING');
  const past = x.entries.filter((e) => e.status === 'DECLINED' || e.status === 'WITHDRAWN');

  const row = (e: Entry) => (
    <li
      key={e.id}
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      data-testid="admin-tournament-entry"
    >
      <div className="min-w-0 flex-1">
        <span className="text-content-emphasis block truncate text-sm font-medium">
          {e.partner ? `${person(e.player)} / ${person(e.partner)}` : person(e.player)}
        </span>
        {e.waitingPosition ? (
          <Caption className="block">{tT('waitingPosition', { place: e.waitingPosition })}</Caption>
        ) : null}
      </div>
      <StatusBadge variant={ENTRY_TONE[e.status]} icon={null}>
        {tT(`entry.${e.status}`)}
      </StatusBadge>
      {x.status === 'IN_PROGRESS' && e.status === 'CONFIRMED' ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={withdraw.isMutating}
          onClick={() => void run(() => withdraw.trigger({ id: e.id }))}
          data-testid="admin-tournament-withdraw"
        >
          {t('withdrawEntry')}
        </Button>
      ) : null}
      {x.status === 'REGISTRATION' && (e.status === 'PENDING' || e.status === 'CONFIRMED') ? (
        <div className="flex gap-2">
          {e.status === 'PENDING' ? (
            <Button
              type="button"
              size="sm"
              disabled={decide.isMutating || x.confirmed >= x.drawSize}
              onClick={() => void run(() => decide.trigger({ id: e.id, verb: 'confirm' }))}
              data-testid="admin-tournament-confirm"
            >
              {t('confirm')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={decide.isMutating}
            onClick={() => void run(() => decide.trigger({ id: e.id, verb: 'decline' }))}
            data-testid="admin-tournament-decline"
          >
            {t('decline')}
          </Button>
        </div>
      ) : null}
    </li>
  );

  return (
    <div className="gap-section flex flex-col" data-testid="admin-tournament">
      <header className="gap-tight flex flex-col">
        <Heading level={1}>{x.name}</Heading>
        <Caption className="block">{l.kind(x)}</Caption>
        <Caption className="block">
          {l.dates(x)}
          {x.venue ? ` · ${x.venue.name}` : ''} · {l.fee(x)}
        </Caption>
        <div className="flex flex-wrap gap-2">
          <StatusBadge
            variant={x.status === 'REGISTRATION' ? 'success' : 'neutral'}
            icon={null}
            data-testid="admin-tournament-status"
          >
            {l.status(x)}
          </StatusBadge>
          <StatusBadge variant="neutral" icon={null}>
            {l.places(x)}
          </StatusBadge>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {x.status === 'DRAFT' ? (
          <Button
            type="button"
            loading={act.isMutating}
            onClick={() => void run(() => act.trigger('open'))}
            data-testid="admin-tournament-open"
          >
            {t('open')}
          </Button>
        ) : null}
        {changeable ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditing(true)}
            data-testid="admin-tournament-edit"
          >
            {t('edit')}
          </Button>
        ) : null}
        {x.status !== 'CANCELLED' && x.status !== 'COMPLETE' ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setCancelling(true)}
            data-testid="admin-tournament-cancel"
          >
            {t('cancelTournament')}
          </Button>
        ) : null}
      </div>
      {x.status === 'DRAFT' ? <Caption>{t('draftHint')}</Caption> : null}

      {error ? (
        <InlineNotice variant="error" data-testid="admin-tournament-error">
          {tT(`error.${error}`)}
        </InlineNotice>
      ) : null}

      {x.description ? (
        <p className="text-content-default text-sm break-words whitespace-pre-wrap">
          {x.description}
        </p>
      ) : null}

      <AdminDraw
        slug={slug}
        tournament={x}
        courts={venues.find((v) => v.id === x.venue?.id)?.courts ?? venues.flatMap((v) => v.courts)}
        onChanged={() => void mutate()}
      />

      <section className="gap-compact flex flex-col" aria-labelledby="admin-tournament-entries">
        <Heading level={2} className="text-base" id="admin-tournament-entries">
          {t('entries', { confirmed: x.confirmed, size: x.drawSize })}
        </Heading>
        {x.entries.length === 0 ? (
          <Caption>{x.status === 'DRAFT' ? t('noEntriesDraft') : t('noEntries')}</Caption>
        ) : (
          <Card elevation="flat" density="none">
            <ul className="divide-border-subtle divide-y">
              {[...confirmed, ...pending, ...past].map(row)}
            </ul>
          </Card>
        )}
      </section>

      {editing ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
          title={t('editTitle')}
          size="md"
        >
          <Sheet.Header title={t('editTitle')} />
          <Sheet.Body>
            <TournamentForm
              venues={venues}
              initial={x}
              busy={update.isMutating}
              submitLabel={t('save')}
              onSubmit={(v) =>
                void run(() => update.trigger(v)).then((ok) => {
                  if (ok) setEditing(false);
                })
              }
              onCancel={() => setEditing(false)}
            />
          </Sheet.Body>
        </Sheet>
      ) : null}

      {cancelling ? (
        <ConfirmDialog
          showModal={cancelling}
          setShowModal={setCancelling}
          title={t('cancelConfirm.title')}
          description={t('cancelConfirm.description')}
          confirmLabel={t('cancelConfirm.yes')}
          cancelLabel={t('cancelConfirm.no')}
          onConfirm={() => void run(() => act.trigger('cancel'))}
        />
      ) : null}
    </div>
  );
}
