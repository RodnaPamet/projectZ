import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import {
  clubTakesOnlineFees,
  clubVenuesForTournaments,
  listClubTournaments,
} from '@/app-layer/usecases/club-tournaments';
import { toTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';
import { readModules } from '@/lib/modules';

import { AdminTournaments } from './AdminTournaments';

export async function generateMetadata() {
  const t = await getTranslations('admin.tournaments');
  return { title: t('metaTitle') };
}

/**
 * «Турнири» (#579): the club's tournaments, and a new one. The desk runs
 * them too (decision 52): the diary's permission. A 404 while the ranking
 * module is off.
 */
export default async function TournamentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!readModules().ranking) notFound();
  const resolved = await resolveTenantPageContext(slug);
  if (resolved.kind !== 'ok') notFound();
  const { ctx } = resolved;
  if (!ctx.permissions.includes('bookings.view_all')) notFound();

  const [t, tNav, items, venues, onlineFees] = await Promise.all([
    getTranslations('admin.tournaments'),
    getTranslations('common.nav'),
    listClubTournaments(ctx.tenantId),
    clubVenuesForTournaments(ctx.tenantId),
    clubTakesOnlineFees(ctx.tenantId),
  ]);

  return (
    <section>
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'tournaments')} />
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>
      <ViewerScope viewerId={ctx.userId}>
        <AdminTournaments
          slug={slug}
          seed={items.map(toTournamentDto)}
          venues={venues}
          onlineFees={onlineFees}
        />
      </ViewerScope>
    </section>
  );
}
