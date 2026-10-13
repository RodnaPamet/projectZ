import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { SeriesBoard } from './SeriesBoard';

export async function generateMetadata() {
  const t = await getTranslations('admin.calendar.series');
  return { title: t('metaTitle') };
}

/**
 * Every weekly series with a live week left, and moving one from a date on
 * (#415; owner decision 2026-10-13). Reached from the diary's header.
 */
export default async function SeriesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (!ctx.permissions.includes('bookings.view_all')) notFound();

  const [t, tNav, courts] = await Promise.all([
    getTranslations('admin.calendar.series'),
    getTranslations('common.nav'),
    // The courts a series may move to: this club's active ones.
    runInTenantContext(ctx.tenantId, (db) =>
      db.resource.findMany({
        where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      }),
    ),
  ]);

  return (
    <section>
      <PageBreadcrumbs
        items={[...clubAdminCrumbs(slug, tNav, 'calendar'), { label: t('title') }]}
      />
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>
      <ViewerScope viewerId={ctx.userId}>
        <SeriesBoard slug={slug} courts={courts} />
      </ViewerScope>
    </section>
  );
}
