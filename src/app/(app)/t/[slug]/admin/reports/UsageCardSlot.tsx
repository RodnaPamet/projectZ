/**
 * ═══ SLOT: THE USAGE CARD (#371) ═══
 *
 * Where "Отчети и такса" shows how the club's bookings came in: the online
 * share of bookings, the pilot's success metric (#379). #371 owns that card and
 * replaces the body of this component with it; the reports page already
 * renders this between the statement's totals and its line items, with the
 * club, its slug and the month the page is showing.
 *
 * Until then it renders nothing, so the page has no empty box and no
 * placeholder copy. It is a Server Component: it may read in the club's own
 * tenant binding (`runInTenantContext(tenantId, …)`) as the page does.
 */
export async function UsageCardSlot(_props: { tenantId: string; slug: string; month: string }) {
  return null;
}
