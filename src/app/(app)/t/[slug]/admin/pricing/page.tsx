import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listCourts } from '@/app-layer/repositories/court';
import { listPricingRules } from '@/app-layer/usecases/pricing-rules';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { PricingBoard, type CourtOption, type PricingRuleView } from './PricingBoard';

export async function generateMetadata() {
  const t = await getTranslations('admin.pricing');
  return { title: t('metaTitle') };
}

/**
 * What the club charges, and why.
 *
 * ═══ WHY EVERY RULE IS LOADED UP FRONT ═══
 *
 * The preview runs `computePrice` in the browser, against the same rules the
 * server would use — so the rules have to be here, not fetched per court on
 * demand. That is a deliberate trade: a club has a handful of courts with a
 * handful of rules each (the query is capped at 200 per court), and the
 * alternative is a server round trip on every change to the preview's day or
 * time, which would make the one genuinely useful thing on this screen feel
 * broken.
 *
 * ═══ DECIMAL DOES NOT CROSS THE BOUNDARY ═══
 *
 * `PricingRule.multiplier` is `Decimal(4,2)`. A Prisma Decimal is a class
 * instance, and handing one to a client component either fails to serialise or
 * arrives as something that is not a number. It is narrowed here, once, where
 * the failure would be obvious — rather than in the component, where
 * `Number(undefined)` would quietly become NaN and every preview would read
 * "NaN €".
 */
export default async function PricingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('admin.pricing_manage')) notFound();

  const t = await getTranslations('admin.pricing');

  const { courts, rulesByCourt } = await runInTenantContext(ctx.tenantId, async (db) => {
    // Archived courts are excluded: a closed court takes no bookings, so its
    // prices decide nothing.
    const rows = await listCourts(db, ctx.tenantId);

    const byCourt: Record<string, PricingRuleView[]> = {};
    for (const c of rows) {
      const rules = await listPricingRules(db, ctx.tenantId, c.id);
      byCourt[c.id] = rules.map((r): PricingRuleView => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        // Decimal → number, at the boundary, once.
        multiplier: r.multiplier === null ? null : Number(r.multiplier),
        fixedPriceCents: r.fixedPriceCents,
        conditions: (r.conditionsJson ?? {}) as PricingRuleView['conditions'],
      }));
    }

    return {
      courts: rows.map((c): CourtOption => ({
        id: c.id,
        name: c.name,
        basePriceCents: c.basePriceCents,
      })),
      rulesByCourt: byCourt,
    };
  });

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <PricingBoard slug={slug} courts={courts} rulesByCourt={rulesByCourt} />
    </section>
  );
}
