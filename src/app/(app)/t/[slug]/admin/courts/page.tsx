import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { listCourts, courtsWereTruncated, COURT_LIST_LIMIT } from '@/app-layer/repositories/court';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

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
 * global instead would be a request-scoped value in a module scope, which is
 * the classic way one user's tenant leaks into another's render.
 *
 * ═══ WHY THE PERMISSION IS CHECKED HERE TOO ═══
 *
 * Middleware gates membership on `/t/[slug]/**`, and `requiredPermission` gates
 * mutations — but every rule in `route-permissions.ts` matches `^/api/`, and
 * they only cover mutating verbs anyway. A page GET is gated by nothing at the
 * edge. The SSO route makes the same observation and repeats its check for the
 * same reason.
 *
 * 404 rather than 403: a MANAGER who lacks `courts.manage` learning that the
 * screen exists is a small leak, and consistency with the not-a-member case
 * costs nothing.
 *
 * ═══ THE BINDING IS `runInTenantContext`, NOT `runAsSuperuser` ═══
 *
 * The public venue index uses the superuser binding because it spans every
 * club and has no tenant to bind to. This is the opposite: there IS a tenant,
 * so the query runs inside it and row security is doing real work. If the
 * binding were wrong the screen would show another club's courts, and nothing
 * would raise.
 */
export default async function CourtsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('courts.manage')) notFound();

  const [t, locale] = await Promise.all([getTranslations('admin.courts'), getLocale()]);
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const tSport = await getTranslations('sports');

  const courts = await runInTenantContext(ctx.tenantId, (db) => listCourts(db, ctx.tenantId));

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      {courtsWereTruncated(courts) && (
        // A capped list that looks complete is the failure the audit route was
        // redesigned to avoid. Saying so is cheaper than paging a screen no
        // real club needs paged.
        <p className="text-content-muted mb-4 text-sm">
          {t('truncated', { limit: COURT_LIST_LIMIT })}
        </p>
      )}

      {courts.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {courts.map((court) => (
            <li key={court.id} className="border-border-subtle bg-bg-surface rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-medium">{court.name}</h2>
                  <p className="text-content-muted text-sm">{tSport(court.sport)}</p>
                </div>
                <StatusBadge variant={court.status === 'ACTIVE' ? 'success' : 'neutral'}>
                  {t(`status.${court.status}`)}
                </StatusBadge>
              </div>

              <dl className="text-content-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt>{t('field.venue')}</dt>
                <dd className="text-content-default">{court.venue.name}</dd>

                <dt>{t('field.setting')}</dt>
                <dd className="text-content-default">
                  {court.isIndoor ? t('setting.indoor') : t('setting.outdoor')}
                </dd>

                <dt>{t('field.capacity')}</dt>
                <dd className="text-content-default">{t('capacity', { count: court.capacity })}</dd>

                <dt>{t('field.basePrice')}</dt>
                {/* Integer cents, formatted through Intl — Bulgarian writes
                    24,00 €, and hand-built '€' + toFixed(2) gets that wrong. */}
                <dd className="text-content-default">{money.format(court.basePriceCents / 100)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
