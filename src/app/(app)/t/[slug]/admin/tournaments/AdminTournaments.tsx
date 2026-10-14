'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { TournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import {
  tournamentErrorKey,
  type TournamentErrorKey,
} from '@/components/tournaments/tournament-errors';
import { useTournamentLabels } from '@/components/tournaments/use-tournament-labels';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { TournamentForm, type TournamentFormValue } from './TournamentForm';

/** The club's tournaments (#579), the latest first, and «Нов турнир». */
export function AdminTournaments({
  slug,
  seed,
  venues,
  onlineFees,
}: {
  slug: string;
  seed: TournamentDto[];
  venues: Array<{
    id: string;
    name: string;
    sports: string[];
    courts?: Array<{ id: string; name: string }>;
  }>;
  /** Whether the club can take entry fees online (#581). */
  onlineFees: boolean;
}) {
  const t = useTranslations('admin.tournaments');
  const tT = useTranslations('tournaments');
  const l = useTournamentLabels();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<TournamentErrorKey | null>(null);
  const { data } = useV1SWR<{ items: TournamentDto[] }>(KEYS.clubTournaments(slug), {
    fallbackData: { items: seed },
  });
  const items = data?.items ?? seed;
  const create = useV1Mutation<TournamentFormValue, { id: string }>({
    url: () => V1.createTournament(slug),
    body: (v) => v,
  });

  async function submit(value: TournamentFormValue) {
    setError(null);
    try {
      const made = await create.trigger(value);
      setCreating(false);
      if (made)
        router.push(
          `/t/${encodeURIComponent(slug)}/admin/tournaments/${encodeURIComponent(made.id)}`,
        );
    } catch (e) {
      setError(tournamentErrorKey(e));
    }
  }

  return (
    <div className="gap-section flex flex-col">
      {venues.length === 0 ? (
        <InlineNotice variant="info">{t('noVenues')}</InlineNotice>
      ) : (
        <Button
          type="button"
          className="self-start"
          onClick={() => setCreating(true)}
          data-testid="tournament-new"
        >
          {t('new')}
        </Button>
      )}

      {items.length === 0 ? (
        <EmptyState title={t('none')} description={t('noneHint')} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="admin-tournaments">
          {items.map((x) => (
            <li key={x.id}>
              <Card
                elevation="flat"
                className="gap-tight focus-within:ring-ring relative flex flex-col focus-within:ring-2"
              >
                <Heading level={2} className="text-base">
                  <Link
                    href={`/t/${encodeURIComponent(slug)}/admin/tournaments/${encodeURIComponent(x.id)}`}
                    className="after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    {x.name}
                  </Link>
                </Heading>
                <Caption className="block">{l.kind(x)}</Caption>
                <Caption className="block">{l.dates(x)}</Caption>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge
                    variant={x.status === 'REGISTRATION' ? 'success' : 'neutral'}
                    icon={null}
                  >
                    {l.status(x)}
                  </StatusBadge>
                  <StatusBadge variant="neutral" icon={null}>
                    {l.places(x)}
                  </StatusBadge>
                  {x.pending > 0 ? (
                    <StatusBadge variant="info" icon={null}>
                      {tT('waitingCount', { count: x.pending })}
                    </StatusBadge>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          title={t('newTitle')}
          size="md"
        >
          <Sheet.Header title={t('newTitle')} description={t('newDescription')} />
          <Sheet.Body>
            {error ? (
              <InlineNotice variant="error" className="mb-4">
                {tT(`error.${error}`)}
              </InlineNotice>
            ) : null}
            <TournamentForm
              venues={venues}
              onlineFees={onlineFees}
              busy={create.isMutating}
              submitLabel={t('create')}
              onSubmit={(v) => void submit(v)}
              onCancel={() => setCreating(false)}
            />
          </Sheet.Body>
        </Sheet>
      ) : null}
    </div>
  );
}
