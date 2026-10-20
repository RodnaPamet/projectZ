import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { clubResourceNouns } from '@/app-layer/usecases/club-nouns';
import { loadVenuePlanEditor } from '@/app-layer/usecases/venue-plan-editor';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { nounListValues } from '@/lib/sports/noun-list';
import { nounsOf } from '@/lib/sports/resource-kinds';

import { PlanEditor } from './PlanEditor';

/**
 * A venue's plan, as the club edits it (#626): where each court lies, moved,
 * turned, resized or drawn. Under Кортове, for the same people: staff with
 * `courts.manage`, checked here as on the courts page (a page GET has no
 * edge rule), and again by the save action itself.
 *
 * Read in the club's tenant context, so another club's venue id finds nothing
 * and is a 404, like a venue that does not exist.
 */

async function readPlan(slug: string, venueId: string) {
  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok' || !result.ctx.permissions.includes('courts.manage')) return null;
  const { ctx } = result;
  const venue = await runInTenantContext(ctx.tenantId, (db) =>
    loadVenuePlanEditor(db, ctx.tenantId, venueId),
  );
  return venue ? { ctx, venue } : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; venueId: string }>;
}) {
  const { slug, venueId } = await params;
  const [t, found] = await Promise.all([
    getTranslations('admin.courts.plan'),
    readPlan(slug, venueId),
  ]);
  return { title: found ? t('metaTitle', { venue: found.venue.name }) : undefined };
}

export default async function VenuePlanEditorPage({
  params,
}: {
  params: Promise<{ slug: string; venueId: string }>;
}) {
  const { slug, venueId } = await params;
  const found = await readPlan(slug, venueId);
  if (!found) notFound();
  const { ctx, venue } = found;

  const [t, tNav, tNouns, locale, nouns] = await Promise.all([
    getTranslations('admin.courts.plan'),
    getTranslations('common.nav'),
    getTranslations('nouns'),
    getLocale(),
    clubResourceNouns(ctx.tenantId),
  ]);
  const title = t('title', { venue: venue.name });

  return (
    <section>
      <PageBreadcrumbs
        items={[
          ...clubAdminCrumbs(slug, tNav, 'courts', nouns, (list) =>
            nounListValues(tNouns, locale, nounsOf(list)),
          ),
          { label: title },
        ]}
      />
      <header className="mb-section">
        <Heading level={1}>{title}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>
      <PlanEditor
        slug={slug}
        venueId={venue.id}
        courts={venue.courts.map((c) => ({
          ...c,
          source: c.source === 'OSM' || c.source === 'CLUB' ? c.source : null,
        }))}
        features={venue.features}
      />
    </section>
  );
}
