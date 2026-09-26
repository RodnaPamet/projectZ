import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { COURT_LIST_LIMIT, courtsWereTruncated, listCourts } from '@/app-layer/repositories/court';
import { countUpcomingBookings } from '@/app-layer/usecases/courts';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { CourtsBoard, type CourtRow } from './CourtsBoard';

export async function generateMetadata() {
  const t = await getTranslations('admin.courts');
  return { title: t('metaTitle') };
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
 */
export default async function CourtsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('courts.manage')) notFound();

  const t = await getTranslations('admin.courts');
  const now = new Date();

  const { courts, venues } = await runInTenantContext(ctx.tenantId, async (db) => {
    // Archived courts are included: the screen offers "reopen", and a court
    // you cannot see is one you cannot bring back.
    const rows = await listCourts(db, ctx.tenantId, { includeArchived: true });
    const sites = await db.venue.findMany({
      where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 100,
    });

    // Sequential on purpose. These are short indexed counts and there are at
    // most COURT_LIST_LIMIT of them; firing them concurrently inside one
    // transaction would interleave statements on a single connection.
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.id, await countUpcomingBookings(db, ctx.tenantId, r.id, now));
    }

    return { courts: rows, venues: sites, counts };
  }).then(({ courts, venues, counts }) => ({
    venues,
    courts: courts.map((c): CourtRow => ({
      id: c.id,
      name: c.name,
      sport: c.sport,
      surface: c.surface,
      isIndoor: c.isIndoor,
      capacity: c.capacity,
      basePriceCents: c.basePriceCents,
      minBookingMinutes: c.minBookingMinutes,
      maxBookingMinutes: c.maxBookingMinutes,
      slotStepMinutes: c.slotStepMinutes,
      status: c.status,
      venueName: c.venue.name,
      upcomingBookings: counts.get(c.id) ?? 0,
    })),
  }));

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      {courtsWereTruncated(courts) && (
        // A capped list that looks complete is the failure the platform audit
        // route was redesigned to avoid. Saying so is cheaper than paging a
        // screen no real club needs paged.
        <p className="text-content-muted mb-4 text-sm">
          {t('truncated', { limit: COURT_LIST_LIMIT })}
        </p>
      )}

      <CourtsBoard slug={slug} courts={courts} venues={venues} />
    </section>
  );
}
