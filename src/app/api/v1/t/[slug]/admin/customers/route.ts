import { type NextRequest } from 'next/server';

import { findClubCustomers } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

import type { DeskCustomerMatchDto } from '@/app/api/v1/_lib/desk-dto';

/**
 * The club's players a desk booking can be linked to (#364), matching `q`: a
 * phone number (any common Bulgarian or international form), or part of a
 * name or email. At most 20.
 *
 * ═══ ONLY THIS CLUB'S PLAYERS ═══
 *
 * A phone is matched against people who have played at THIS club — their own
 * `User.phone`, or an earlier desk booking the club linked to them — never
 * against every account. Whether a number belongs to somebody on playerz is
 * not something any club's staff can learn here. The phone is not returned.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const q = req.nextUrl.searchParams.get('q') ?? '';
  if (q.length > 80) throw new ValidationError('`q` is at most 80 characters', { field: 'q' });

  const matches = await inTenant(ctx, (db) => findClubCustomers(db, ctx.tenantId, q));
  return ok(
    matches.map((m): DeskCustomerMatchDto => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      matchedBy: m.matchedBy,
    })),
  );
}

export const GET = defineV1Route(handler);
