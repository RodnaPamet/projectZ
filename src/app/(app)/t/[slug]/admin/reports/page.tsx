import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { StatementView } from '@/components/billing/StatementView';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { isMonth, monthsBack, statementMonthOf } from '@/lib/billing/club-fee';
import { toClubStatementDto } from '@/lib/billing/statement-dto';
import { V1 } from '@/lib/data/keys';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { ReportsMonthNav } from './ReportsMonthNav';
import { UsageCardSlot } from './UsageCardSlot';

export async function generateMetadata() {
  const t = await getTranslations('admin.reports');
  return { title: t('metaTitle') };
}

/**
 * "Отчети и такса" (#372): the club's monthly fee statement.
 *
 * OWNERS AND MANAGERS ONLY. The page asks `admin.billing_manage`, the
 * permission the nav item is filtered by and the statement API demands, so the
 * link is never offered to somebody the page would refuse, and STAFF see
 * neither.
 *
 * ═══ WHAT IT SHOWS ═══
 *
 * The month at the club (`?month=YYYY-MM`, this month by default): online
 * bookings played, the court revenue on them, the fee percentage, the fee due,
 * whether the free period covers the month, a usage card (#371), the line
 * items, and the CSV download. Everything comes from the append-only ledger,
 * so the page reads the same however often it is opened.
 *
 * The month is in the URL, not in state: a month is a link the owner can send,
 * and the router's `auto` prefetch fetches only down to `loading.tsx` (T30).
 */
export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (!ctx.permissions.includes('admin.billing_manage')) notFound();

  const current = statementMonthOf(new Date());
  const asked = typeof sp.month === 'string' ? sp.month : '';
  // A future month has no lines by construction; an unparseable one is this month.
  const month = isMonth(asked) && asked <= current ? asked : current;

  const [statement, t] = await Promise.all([
    runInTenantContext(ctx.tenantId, (db) => loadClubStatement(db, ctx.tenantId, month)),
    getTranslations('admin.reports'),
  ]);
  if (!statement) notFound();

  const months = monthsBack(statement.clubSinceMonth, current);
  if (!months.includes(month)) months.push(month);

  return (
    <section>
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <div className="gap-section grid">
        <ReportsMonthNav slug={ctx.tenantSlug} months={months} month={month} />

        <StatementView
          statement={toClubStatementDto(statement)}
          csvHref={V1.clubStatementCsv(ctx.tenantSlug, month)}
        >
          <UsageCardSlot tenantId={ctx.tenantId} slug={ctx.tenantSlug} month={month} />
        </StatementView>
      </div>
    </section>
  );
}
