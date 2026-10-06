import { type NextRequest } from 'next/server';

import { deskPreviewSchema } from '@/app-layer/schemas/desk';
import { previewDesk } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { toDeskPreview } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * What a desk booking — or each week of a series — would be: its instants, the
 * server's quote, and whether the court is `free`, `taken` or `unavailable`
 * (closed, or a time the clocks skip that day). The sheet shows it before the
 * desk commits, and lists the weeks to skip.
 *
 * A read, so a GET with the rule in the query: `resourceId`, `date`,
 * `startTime`, `durationMinutes`, and for a series `weeks` or `until`. It
 * promises nothing: creating decides again, and a week taken in between is a
 * 409 SERIES_CLASH then.
 */
function readQuery(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const weeks = q.get('weeks');
  const until = q.get('until');
  const raw = {
    resourceId: q.get('resourceId') ?? '',
    date: q.get('date') ?? '',
    startTime: q.get('startTime') ?? '',
    durationMinutes: Number(q.get('durationMinutes')),
    ...(weeks !== null || until !== null
      ? {
          repeat: {
            ...(weeks !== null ? { weeks: Number(weeks) } : {}),
            ...(until !== null ? { until } : {}),
          },
        }
      : {}),
  };
  const parsed = deskPreviewSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  // `repeat.weeks` is the query's `weeks`: name the parameter the client sent.
  const field = first?.path.at(-1)?.toString() || 'query';
  throw new ValidationError(`\`${field}\`: ${first?.message ?? 'invalid'}`, {
    field,
    issues: parsed.error.issues,
  });
}

async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const query = readQuery(req);
  const preview = await inTenant(ctx, (db) => previewDesk(db, ctx.tenantId, query));
  if (!preview) throw new NotFoundError('Resource not found');

  return ok(toDeskPreview(preview));
}

export const GET = defineV1Route(handler);
