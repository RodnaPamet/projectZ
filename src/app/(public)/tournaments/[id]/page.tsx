import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTournament } from '@/app-layer/usecases/club-tournaments';
import { toTournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { gamesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { chromeIdentity } from '@/components/layout/player-chrome-data';
import { ViewerScope } from '@/lib/data/provider';
import { readModules } from '@/lib/modules';

import { TournamentDetail } from './TournamentDetail';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('tournaments');
  const x = readModules().ranking ? await getTournament(id, null) : null;
  return x ? { title: t('metaTitle', { name: x.name }) } : { robots: { index: false } };
}

/**
 * /tournaments/{id} (#579): one tournament, public to read; entering and
 * withdrawing for a signed-in player. A 404 while the ranking module is off,
 * for a draft, or at a club that is not public.
 */
export default async function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!readModules().ranking) notFound();
  const [me, tNav] = await Promise.all([chromeIdentity(), getTranslations('common.nav')]);
  const viewerId = me?.userId ?? null;
  const x = await getTournament(id, viewerId);
  if (!x) notFound();

  const view = (
    <TournamentDetail
      seed={toTournamentViewDto(x)}
      signedIn={viewerId !== null}
      loginHref={`/login?next=${encodeURIComponent(`/tournaments/${id}`)}`}
    />
  );
  return (
    <div className="bg-bg-page text-content-default safe-area-x">
      <div className="in-shell:p-0 mx-auto max-w-2xl px-6 py-10">
        {/* Игри / the tournament, in the top bar from md (Игри → «Турнири», 53). */}
        {me ? <PageBreadcrumbs items={gamesCrumbs(tNav, x.name)} className="hidden" /> : null}
        {viewerId ? <ViewerScope viewerId={viewerId}>{view}</ViewerScope> : view}
      </div>
    </div>
  );
}
