import { loadClubOnlineShare } from '@/app-layer/usecases/usage-report';
import { OnlineShareCard } from '@/components/reports/online-share-card';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * ═══ SLOT: THE USAGE CARD (#371) ═══
 *
 * Where "Отчети и такса" shows how the club's bookings came in: the online
 * share of bookings, the pilot's success metric (#379). The reports page
 * renders this between the statement's totals and its line items, with the
 * club, its slug and the month the page is showing.
 *
 * "Онлайн резервации" for that month and the five before it, so the card
 * follows the month picker. Read in the club's own tenant binding, as the page
 * reads its statement: RLS keeps it to this club's bookings. The online share
 * is defined in src/app-layer/usecases/usage-report.ts.
 *
 * The statement is what the owner came for, so the card never takes the page
 * down with it: if its read fails, the page renders without it and the
 * failure is a warning in the log.
 */
export async function UsageCardSlot({
  tenantId,
  month,
}: {
  tenantId: string;
  slug: string;
  month: string;
}) {
  const data = await runInTenantContext(tenantId, (db) =>
    loadClubOnlineShare(db, tenantId, { month }),
  ).catch((error: unknown) => {
    logger.warn('online share card not rendered', {
      component: 'usage',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  return data ? <OnlineShareCard data={data} /> : null;
}
