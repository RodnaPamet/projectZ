import type { NextRequest } from 'next/server';

import {
  AccountNotFoundForDeletionError,
  readMyDeletionStanding,
  type DeletionStanding,
} from '@/app-layer/usecases/account-deletion';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rfc3339 } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/deletion — can this account be deleted now, and what would
 * it lose (#628)?
 *
 * The same standing the web's «Изтриване на профила» is drawn from
 * (`readMyDeletionStanding`), so a native client can say before anyone types
 * the word what `DELETE /me` will answer:
 *
 *   allowed   it may go; `credit` lists the unused credit it loses, club by club
 *   blocked   upcoming bookings, lessons it teaches or tournaments it is in
 *             stand in the way first; `blocked` says which and what frees it
 *   club      a club account: the platform deletes it on request
 *
 * Credit is in euros: the clubs' only currency, as the web says it.
 */
const CREDIT_CURRENCY = 'EUR';

function dto(standing: DeletionStanding) {
  if (standing.kind === 'club') return { kind: 'club', credit: [], blocked: null };
  const credit = standing.credit.map((c) => ({
    club: c.club,
    amountCents: c.balanceCents,
    currency: CREDIT_CURRENCY,
  }));
  if (standing.kind === 'allowed') return { kind: 'allowed', credit, blocked: null };
  return {
    kind: 'blocked',
    credit,
    blocked: {
      total: standing.total,
      lessons: standing.lessons,
      tournaments: standing.tournaments,
      bookings: standing.bookings.map((b) => ({
        bookingId: b.bookingId,
        venueName: b.venueName,
        courtName: b.courtName,
        resourceType: b.resourceType,
        timezone: b.timezone,
        startTs: rfc3339(b.startTs),
        endTs: rfc3339(b.endTs),
        role: b.role,
        cure: b.cure,
        cancellableUntil: rfc3339(b.cancellableUntil),
        deletableFrom: rfc3339(b.deletableFrom),
      })),
    },
  };
}

async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  try {
    return ok(dto(await readMyDeletionStanding(ctx.userId)));
  } catch (err) {
    // Gone between the session check and the read: not signed in.
    if (err instanceof AccountNotFoundForDeletionError)
      throw new UnauthorizedError('Authentication required');
    throw err;
  }
}

export const GET = defineV1Route(handler);
