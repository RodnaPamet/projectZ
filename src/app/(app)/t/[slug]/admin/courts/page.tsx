import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { COURT_LIST_LIMIT, courtsWereTruncated } from '@/app-layer/repositories/court';
import { clubResourceNouns } from '@/app-layer/usecases/club-nouns';
import { loadCourtsScreen } from '@/app-layer/usecases/courts';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { resourceNouns } from '@/lib/sports/resource-kinds';

import { CourtsBoard, type CourtRow } from './CourtsBoard';

/**
 * The tab title says what the club plays on, as the screen's heading and its
 * nav item do (P51, #362): "Писти" at a karting club, "Кортове и писти" at one
 * with both. A visitor the page refuses gets the plain title; the page answers
 * them with its 404.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const [t, result] = await Promise.all([
    getTranslations('admin.courts'),
    params.then(({ slug }) => resolveTenantPageContext(slug)),
  ]);
  const nouns = result.kind === 'ok' ? await clubResourceNouns(result.ctx.tenantId) : 'court';
  return {
    title: t(
      nouns === 'track' ? 'track.metaTitle' : nouns === 'mixed' ? 'mixed.metaTitle' : 'metaTitle',
    ),
  };
}

/**
 * The club's courts — the first admin screen, and the pattern the other four
 * should copy.
 *
 * ═══ WHY IT RESOLVES THE CONTEXT AGAIN ═══
 *
 * The layout already did. App Router gives a layout no way to hand props to the
 * page beneath it, and `resolveTenantPageContext` is wrapped in React `cache`,
 * so the second call in the same render costs nothing. Reaching for a module
 * global instead would be a request-scoped value in module scope, which is the
 * classic way one user's tenant leaks into another's render.
 *
 * ═══ WHY THE PERMISSION IS CHECKED HERE TOO ═══
 *
 * Middleware gates membership on `/t/[slug]/**`, and `requiredPermission` gates
 * mutations — but every rule in `route-permissions.ts` matches `^/api/`, and
 * covers mutating verbs only. A page GET is gated by nothing at the edge. The
 * SSO route makes the same observation and repeats its check for the same
 * reason.
 *
 * 404 rather than 403: a MANAGER who lacks `courts.manage` learning the screen
 * exists is a small leak, and consistency with the not-a-member case is free.
 *
 * ═══ THE BINDING IS runInTenantContext, NOT runAsSuperuser ═══
 *
 * The public venue index uses the superuser binding because it spans every club
 * and has no tenant to bind to. This is the opposite: there IS a tenant, so the
 * query runs inside it and row security does real work. Bound wrong, the screen
 * would show another club's courts and nothing would raise.
 *
 * ═══ A CONSTANT NUMBER OF QUERIES (T23) ═══
 *
 * `loadCourtsScreen` reads courts, venues and every court's upcoming-booking
 * count in one transaction — the counts as one grouped query, where they were
 * one `count` per court. The page's database cost no longer grows with the
 * club (see `countUpcomingBookingsByCourt`).
 *
 * Club admin stays RSC + Server Actions (the hybrid-by-surface decision); the
 * board on top of it is where the optimistic archive lives.
 */
export default async function CourtsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('courts.manage')) notFound();

  const t = await getTranslations('admin.courts');
  const now = new Date();

  const { courts, venues, upcoming } = await runInTenantContext(ctx.tenantId, (db) =>
    loadCourtsScreen(db, ctx.tenantId, now),
  );

  const rows = courts.map((c): CourtRow => ({
    id: c.id,
    name: c.name,
    sport: c.sport,
    resourceType: c.resourceType,
    surface: c.surface,
    isIndoor: c.isIndoor,
    capacity: c.capacity,
    basePriceCents: c.basePriceCents,
    minBookingMinutes: c.minBookingMinutes,
    maxBookingMinutes: c.maxBookingMinutes,
    slotStepMinutes: c.slotStepMinutes,
    status: c.status,
    venueName: c.venue.name,
    upcomingBookings: upcoming.get(c.id) ?? 0,
  }));

  // "Писти" at a karting club, "Кортове и писти" at one with both (P51), as
  // the tab title and the club nav name the screen (#362).
  const nouns = resourceNouns(rows.map((r) => r.resourceType));

  const tNav = await getTranslations('common.nav');

  return (
    <section>
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'courts', nouns)} />
      <header className="mb-section">
        <Heading level={1}>
          {t(nouns === 'track' ? 'track.title' : nouns === 'mixed' ? 'mixed.title' : 'title')}
        </Heading>
        <p className="text-content-muted mt-1 text-sm">
          {t(
            nouns === 'track'
              ? 'track.subtitle'
              : nouns === 'mixed'
                ? 'mixed.subtitle'
                : 'subtitle',
          )}
        </p>
      </header>

      {courtsWereTruncated(rows) && (
        // A capped list that looks complete is the failure the platform audit
        // route was redesigned to avoid. Saying so is cheaper than paging a
        // screen no real club needs paged.
        <InlineNotice variant="info" className="mb-default">
          {t(
            nouns === 'track'
              ? 'track.truncated'
              : nouns === 'mixed'
                ? 'mixed.truncated'
                : 'truncated',
            { limit: COURT_LIST_LIMIT },
          )}
        </InlineNotice>
      )}

      <CourtsBoard slug={slug} courts={rows} venues={venues} />
    </section>
  );
}
