import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import {
  clubTakesOnlineFees,
  clubVenuesForTournaments,
  getClubTournament,
} from '@/app-layer/usecases/club-tournaments';
import { toClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';
import { readModules } from '@/lib/modules';

import { AdminTournamentDetail } from './AdminTournamentDetail';

export async function generateMetadata() {
  const t = await getTranslations('admin.tournaments');
  return { title: t('metaTitle') };
}

/** One of the club's tournaments (#579): its details, its status, its entries. */
export default async function TournamentAdminPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  if (!readModules().ranking) notFound();
  const resolved = await resolveTenantPageContext(slug);
  if (resolved.kind !== 'ok') notFound();
  const { ctx } = resolved;
  if (!ctx.permissions.includes('bookings.view_all')) notFound();

  const [tNav, x, venues, onlineFees] = await Promise.all([
    getTranslations('common.nav'),
    getClubTournament(ctx.tenantId, id),
    clubVenuesForTournaments(ctx.tenantId),
    clubTakesOnlineFees(ctx.tenantId),
  ]);
  if (!x) notFound();

  return (
    <section>
      <PageBreadcrumbs
        items={[
          ...clubAdminCrumbs(slug, tNav, 'tournaments'),
          { label: x.name, href: `/t/${slug}/admin/tournaments/${id}` },
        ]}
      />
      <ViewerScope viewerId={ctx.userId}>
        <AdminTournamentDetail
          slug={slug}
          seed={toClubTournamentDto(x)}
          venues={venues}
          onlineFees={onlineFees}
        />
      </ViewerScope>
    </section>
  );
}
