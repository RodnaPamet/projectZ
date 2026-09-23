import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * Releasing slots held by checkouts nobody finished.
 *
 * ═══ WHY THIS HAS TO EXIST ═══
 *
 * `booking_no_overlap` counts PENDING as occupying a slot — deliberately, so
 * that a player at checkout is not gazumped. `Booking.expiresAt` was written
 * on every booking to bound that, and until now NOTHING read it. A player who
 * opened checkout and closed the tab held a court for ever.
 *
 * The availability endpoint mirrors the constraint exactly, so those holds
 * were invisible in the UI as well: a court showing as taken, indefinitely,
 * for a booking that was never paid for.
 *
 * ═══ CANCELLED, NOT A NEW STATUS ═══
 *
 * BookingStatus has no EXPIRED. Adding one would mean touching the exclusion
 * constraint's WHERE clause, every status comparison, and the DTO — for a
 * distinction the audit entry already records. CANCELLED is what frees the
 * slot, which is the point.
 *
 * This deliberately does NOT go through `cancelBooking`: that writes a
 * Cancellation row with a refund quote, and there is nothing to refund. A
 * refund receipt for money never taken would be a lie in the ledger.
 *
 * ═══ THE RACE, AND WHY IT IS SAFE ═══
 *
 * A player can be completing 3-D Secure as this runs. The filter is
 * `status: 'PENDING'`, so if payment confirmed the booking a moment earlier,
 * zero rows match and it is left alone.
 *
 * The other order — swept at 15:00, payment lands at 15:01 — is handled by
 * the webhook: it finds the booking no longer PENDING, records the Payment
 * anyway and writes a PAYMENT_UNAPPLIED audit entry so somebody can refund
 * it. That is not silent, which is what matters.
 */

/** One run's ceiling. A sweep is not a migration; it comes back in a minute. */
const MAX_PER_RUN = 500;

export interface ReleaseResult {
  scanned: number;
  released: number;
  /** True when the cap was hit, so the caller knows more remain. */
  truncated: boolean;
}

export async function releaseExpiredBookings(
  db: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReleaseResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? MAX_PER_RUN, MAX_PER_RUN);

  // guardrail-allow: cross-tenant — a sweep runs for the whole platform; it
  // has no session and no slug to bind to. Every write below re-states the
  // booking's own tenantId.
  const expired = await db.booking.findMany({
    where: {
      status: 'PENDING',
      expiresAt: { not: null, lt: now },
    },
    select: { id: true, tenantId: true, resourceId: true, startTs: true, expiresAt: true },
    orderBy: { expiresAt: 'asc' },
    take: limit,
  });

  let released = 0;

  for (const booking of expired) {
    // Re-checked inside the write rather than trusted from the read above. A
    // payment could have confirmed this booking in the milliseconds since, and
    // cancelling a paid booking is far worse than missing one this round.
    const updated = await db.booking.updateMany({
      where: { id: booking.id, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: now },
    });

    if (updated.count === 0) continue;

    released += 1;

    await appendAuditEntry(db, {
      tenantId: booking.tenantId,
      actorUserId: null,
      // Nobody cancelled this. A timer did.
      actorType: 'SYSTEM',
      entity: 'Booking',
      entityId: booking.id,
      action: AUDIT_ACTIONS.BOOKING_EXPIRED,
      details: `Held slot released: checkout not completed within the window`,
      detailsJson: {
        category: 'booking',
        summary: 'PENDING booking expired and its slot was released',
        before: { status: 'PENDING' },
        after: { status: 'CANCELLED' },
        expiresAt: booking.expiresAt?.toISOString() ?? null,
        source: 'release_expired_bookings',
      },
    });
  }

  return { scanned: expired.length, released, truncated: expired.length === limit };
}
