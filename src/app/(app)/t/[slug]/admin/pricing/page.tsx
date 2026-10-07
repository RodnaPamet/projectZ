import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { clubOnlineBookingCap } from '@/app-layer/usecases/booking-rules';
import { loadPricingScreen } from '@/app-layer/usecases/pricing-rules';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { resourceNoun } from '@/lib/sports/resource-kinds';

import { CancellationCutoffForm, type CutoffVenue } from './CancellationCutoffForm';
import { OnlineBookingCapForm } from './OnlineBookingCapForm';
import { PricingBoard, type CourtOption } from './PricingBoard';
import { toPricingRuleView, type PricingRuleView } from './rule-view';

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
 *
 * ═══ A CONSTANT NUMBER OF QUERIES (T24) ═══
 *
 * `loadPricingScreen` reads the courts and then every court's rules in ONE
 * query, grouped in memory inside the same transaction — where this page
 * awaited `listPricingRules` once per court. The page's database cost no
 * longer grows with the club (see `listPricingRulesForCourts`).
 */
export default async function PricingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('admin.pricing_manage')) notFound();

  const t = await getTranslations('admin.pricing');

  // The player-cancellation cutoff (#354) is a venue term, edited here beside
  // the prices by whoever holds `admin.venue_manage`.
  const canSetCutoff = ctx.permissions.includes('admin.venue_manage');

  // So is the club's cap on a player's upcoming online bookings (#380), which
  // is one number for the whole club.
  const { courts, rulesByCourt, venues, bookingCap } = await runInTenantContext(
    ctx.tenantId,
    async (db) => {
      const screen = await loadPricingScreen(db, ctx.tenantId);
      const venues: CutoffVenue[] = canSetCutoff
        ? await db.venue.findMany({
            where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
            select: { id: true, name: true, cancellationCutoffHours: true },
            orderBy: { name: 'asc' },
            take: 50,
          })
        : [];
      const bookingCap = canSetCutoff ? await clubOnlineBookingCap(db, ctx.tenantId) : null;
      return { ...screen, venues, bookingCap };
    },
  );

  const byCourt: Record<string, PricingRuleView[]> = {};
  for (const [courtId, rules] of rulesByCourt) {
    byCourt[courtId] = rules.map(toPricingRuleView);
  }

  const options = courts.map((c): CourtOption => ({
    id: c.id,
    name: c.name,
    noun: resourceNoun(c.resourceType),
    basePriceCents: c.basePriceCents,
    // The preview must price per BLOCK, as quoteBooking does. Without this the
    // island cannot decompose the span and shows the price of a single unit
    // however long the booking is.
    minBookingMinutes: c.minBookingMinutes,
  }));

  return (
    <section>
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <CancellationCutoffForm slug={slug} venues={venues} />

      {bookingCap !== null && <OnlineBookingCapForm slug={slug} limit={bookingCap} />}

      <PricingBoard slug={slug} courts={options} rulesByCourt={byCourt} />
    </section>
  );
}
