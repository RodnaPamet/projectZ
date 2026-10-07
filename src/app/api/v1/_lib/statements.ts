import { NextResponse } from 'next/server';

import type { ClubStatement } from '@/app-layer/usecases/club-fees';
import { hasPermission, type RequestContext } from '@/app-layer/types';
import { isMonth, statementMonthOf } from '@/lib/billing/club-fee';
import { statementCsv, statementFilename } from '@/lib/billing/statement-csv';
export { toClubStatementDto, toFeeOverviewRowDto } from '@/lib/billing/statement-dto';
import { AppError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors/types';

/**
 * Shared by the club's statement routes and the platform's (#372).
 *
 * ═══ WHO MAY READ A CLUB'S STATEMENT ═══
 *
 * `admin.billing_manage`: OWNER and MANAGER hold it, STAFF, COACH and PLAYER do
 * not. It is the permission that already guards where the club's money lands
 * (`/connect`), and a statement is the club's bill.
 *
 * A caller with no membership at the slug gets a 404, the same answer as for a
 * slug that does not exist: a statement route must not confirm that a club is
 * there to somebody outside it. A member without the permission gets a 403
 * naming it, which tells a member of THIS club nothing they did not know.
 */
export function requireStatementReader(ctx: RequestContext): asserts ctx is RequestContext & {
  userId: string;
  tenantId: string;
} {
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  if (!ctx.tenantId) throw new NotFoundError('Club not found');
  if (!hasPermission(ctx, 'admin.billing_manage')) {
    throw new AppError('Forbidden', 'FORBIDDEN', 403, true, {
      requiredPermission: 'admin.billing_manage',
    });
  }
}

/** `?month=YYYY-MM`, or this month at the club when absent. */
export function readStatementMonth(params: URLSearchParams, now: Date = new Date()): string {
  const raw = params.get('month');
  if (raw === null || raw === '') return statementMonthOf(now);
  if (!isMonth(raw)) {
    throw new ValidationError('`month` must be YYYY-MM', { field: 'month' });
  }
  return raw;
}

/**
 * The statement as a download. `no-store`: it is one club's money, and a shared
 * cache must never hand it to the next person who asks for the same URL.
 */
export async function statementCsvResponse(s: ClubStatement): Promise<NextResponse> {
  const body = await statementCsv(s);
  const filename = statementFilename(s.club.slug, s.month);
  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
