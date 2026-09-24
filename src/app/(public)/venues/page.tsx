import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { MobileListAffordances } from '@/components/mobile/MobileListAffordances';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { listVenues } from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

export async function generateMetadata() {
  const t = await getTranslations('venues');
  return { title: t('metaTitle') };
}

/**
 * Public venue search.
 *
 * A server component reading through the repository, so the QUERY lives in
 * venue.ts where the query-shape and tenant-isolation ratchets scan it. The
 * BINDING is this file's own responsibility, and nothing about going through
 * the repository supplies it — see the comment on the call below.
 */
export default async function VenuesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; city?: string; sport?: string }>;
}) {
  const sp = await searchParams;
  const t = await getTranslations('venues');
  const locale = await getLocale();
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });

  // BYPASSRLS, not the raw singleton — the same binding /api/venues uses, and
  // for the same reason. `venue` carries FORCE ROW LEVEL SECURITY keyed on
  // app.tenant_id, and a public search has no tenant to bind: as app_user this
  // returns ZERO ROWS, so the page renders "no venues in Sofia" with nothing in
  // the logs. It only appeared to work because the dev connection role is a
  // cluster superuser and is exempt from row security.
  //
  // Cross-tenant is the point — a player hunting a padel court does not know
  // which club owns it — so what keeps this read safe is `status: ACTIVE` in
  // listVenues, not the tenant policy.
  //
  // `runAsSuperuser` directly rather than `asSuperuser` from the v1 bindings:
  // that helper takes a RequestContext, which a page does not have.
  const { items } = await runAsSuperuser((db) =>
    listVenues(
      db,
      {
        q: sp.q,
        city: sp.city,
        sport: sp.sport as never,
      },
      { limit: 20 },
    ),
  );

  return (
    <main className="bg-bg-page text-content-default safe-area-top safe-area-x min-h-screen px-6 py-10">
      {/* Pull down to refresh; jump back to the top of a long list. Both are
          client-only gestures, so they live in an island rather than dragging
          this whole server component to the client. */}
      <MobileListAffordances />

      <header className="mb-8">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        {/* ICU plural, not `venue{s}`. Bulgarian does not form plurals by
            appending a letter, and the count word itself changes — so the
            shape has to come from the catalogue, not from the JSX. */}
        <p className="text-content-muted mt-1 text-sm">{t('count', { count: items.length })}</p>
      </header>

      {items.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((v) => {
            const sports = [...new Set(v.resources.map((c) => c.sport))];
            const from = v.resources.length
              ? Math.min(...v.resources.map((c) => c.basePriceCents))
              : null;

            return (
              <li key={v.id}>
                <Link
                  href={`/venues/${v.slug}`}
                  className="border-border-subtle bg-bg-default hover:border-border-emphasis block rounded-lg border p-4 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-content-emphasis font-medium">{v.name}</h2>
                    {v.reviewCount > 0 && (
                      <StatusBadge variant="success">
                        {Number(v.avgRating).toFixed(1)} ★
                      </StatusBadge>
                    )}
                  </div>

                  <p className="text-content-muted mt-1 text-sm">
                    {v.city}, {v.country}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-1">
                    {sports.map((s) => (
                      <StatusBadge key={s} variant="neutral">
                        {s.toLowerCase()}
                      </StatusBadge>
                    ))}
                  </div>

                  {from !== null && (
                    <p className="text-content-subtle mt-3 text-xs">
                      {/* Formatted through Intl, not `€` + toFixed. Bulgarian
                          writes the amount before the symbol and uses a comma
                          for the decimal separator — "24,00 €", not "€24.00". */}
                      {t('priceFrom', { price: money.format(from / 100) })}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
