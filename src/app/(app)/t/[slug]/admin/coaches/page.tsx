import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listClubCoaches } from '@/app-layer/usecases/coach-links';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

import { CoachesBoard, type ClubCoachRow } from './CoachesBoard';

/**
 * /t/{slug}/admin/coaches — the coaches who teach at the club, and the ones
 * asking to (#546; owner decision 4).
 *
 * The owner's and the manager's (`admin.staff_manage`): the desk does not
 * decide who works here. Each coach is shown by their public card, which is
 * what the platform approved for publication; an invited coach the platform
 * has not approved yet is a name and a note saying so.
 */
export async function generateMetadata() {
  const t = await getTranslations('admin.coaches');
  return { title: t('metaTitle') };
}

export default async function ClubCoachesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (!ctx.permissions.includes('admin.staff_manage')) notFound();

  const [t, tNav, coaches] = await Promise.all([
    getTranslations('admin.coaches'),
    getTranslations('common.nav'),
    listClubCoaches(ctx.tenantId),
  ]);

  const rows = coaches.map((c): ClubCoachRow => ({
    id: c.id,
    status: c.status === 'REQUESTED' ? 'REQUESTED' : 'ACTIVE',
    venueName: c.venue.name,
    name: c.coach.name,
    approved: c.coach.approved,
    bio: c.coach.bio,
    qualifications: c.coach.qualifications,
    sports: c.coach.sports.map((s) => ({
      sport: s.sport,
      levelMin: s.levelMin,
      levelMax: s.levelMax,
    })),
    hourlyRateCents: c.hourlyRateCents,
    groupRateCents: c.groupRateCents,
    currency: c.currency,
    lessonMinutes: c.lessonMinutes,
    cancelCutoffHours: c.cancelCutoffHours,
    hours: c.hours,
    missing: c.missing,
  }));

  return (
    <section>
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'coaches')} />
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>
      <CoachesBoard slug={slug} coaches={rows} />
    </section>
  );
}
