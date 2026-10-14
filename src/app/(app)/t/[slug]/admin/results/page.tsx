import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listClubResults } from '@/app-layer/usecases/match-results';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { ViewerScope } from '@/lib/data/provider';
import { readModules } from '@/lib/modules';

import { ClubResults } from './ClubResults';

export async function generateMetadata() {
  const t = await getTranslations('admin.results');
  return { title: t('metaTitle') };
}

/**
 * «Резултати» (#575): the club's results. Those a player rejected wait at the
 * top for the desk to confirm one version or void it (decision 34); the recent
 * ones follow. The diary's permission, as the nav item asks; a 404 while the
 * ranking module is off, as its nav item is hidden then.
 */
export default async function ResultsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!readModules().ranking) notFound();

  const resolved = await resolveTenantPageContext(slug);
  if (resolved.kind !== 'ok') notFound();
  const { ctx } = resolved;
  if (!ctx.permissions.includes('bookings.view_all')) notFound();

  const [t, tNav, waiting, recent] = await Promise.all([
    getTranslations('admin.results'),
    getTranslations('common.nav'),
    runInTenantContext(ctx.tenantId, (db) =>
      listClubResults(db, ctx.tenantId, { status: 'REJECTED' }),
    ),
    runInTenantContext(ctx.tenantId, (db) => listClubResults(db, ctx.tenantId)),
  ]);

  return (
    <section>
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'results')} />
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>
      <ViewerScope viewerId={ctx.userId}>
        <ClubResults slug={slug} waiting={waiting} recent={recent} />
      </ViewerScope>
    </section>
  );
}
