import type { NextRequest } from 'next/server';
import type { z } from 'zod';

import { hasPermission, type RequestContext } from '@/app-layer/types';
import { AppError, UnauthorizedError, ValidationError } from '@/lib/errors/types';

/**
 * Shared by the desk-booking and booking-series routes (#364).
 *
 * ═══ `bookings.view_all`, ON EVERY VERB ═══
 *
 * The writes are gated in ROUTE_PERMISSIONS (`/admin/desk-bookings`,
 * `/admin/booking-series`, `/admin/customers`) and refused by
 * `contextFromRequest` before a handler runs. The table has no rows for GET, so
 * the reads are refused HERE, with the same 403 body. It is the permission the
 * diary and the staff cancel already use: STAFF, MANAGER and OWNER hold it;
 * COACH and PLAYER do not. `bookings.create` would be the wrong one precisely
 * because every PLAYER holds it.
 */
export function requireDesk(ctx: RequestContext): asserts ctx is RequestContext & {
  userId: string;
  tenantId: string;
} {
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  if (!ctx.tenantId || !hasPermission(ctx, 'bookings.view_all')) {
    throw new AppError('Forbidden', 'FORBIDDEN', 403, true, {
      requiredPermission: 'bookings.view_all',
    });
  }
}

/** The JSON body through a zod schema; the first issue names the field. */
export async function parseDeskBody<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
): Promise<z.infer<S>> {
  const raw = await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  });
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  const field = first?.path.join('.') || 'body';
  throw new ValidationError(`\`${field}\`: ${first?.message ?? 'invalid'}`, {
    field,
    issues: parsed.error.issues,
  });
}

/** The client's `Idempotency-Key`, required on a create. */
export function requireIdempotencyKey(req: NextRequest): string {
  const key = req.headers.get('idempotency-key')?.trim();
  if (!key) {
    throw new ValidationError('An `Idempotency-Key` header is required', {
      field: 'Idempotency-Key',
    });
  }
  if (key.length > 128) {
    throw new ValidationError('`Idempotency-Key` is at most 128 characters', {
      field: 'Idempotency-Key',
    });
  }
  return key;
}
