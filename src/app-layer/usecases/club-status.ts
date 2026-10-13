import type { PrismaClient, TenantStatus } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { cancelBooking } from './booking';
import { notifyBookingCancelled } from './booking-notifications';

/**
 * Taking a club offline, and bringing it back (#254). The owner's decisions
 * of 2026-10-13:
 *
 *   SUSPENDED  hidden from players and not bookable; every upcoming booking is
 *              cancelled with notice; the staff keep READ-ONLY access to their
 *              admin (page-context.ts refuses their writes)
 *   CLOSED     the same, for good: a closed club does not reopen
 *   ACTIVE     back from a suspension: visible and bookable again. The
 *              bookings the suspension cancelled STAY cancelled; those players
 *              were told, and many will have booked elsewhere
 *
 * Players stop seeing a non-active club through `publicVenueFilter` (every
 * public venue read) and `resolvePlayerTenant` (booking, joining), which have
 * honoured the column since #298; this is the first code that writes it.
 *
 * ═══ TWO STEPS: THE STATUS, THEN THE BOOKINGS ═══
 *
 * `setClubStatus` runs inside the platform's audited transaction and only
 * moves the status, so the club is hidden and unbookable the moment it
 * commits. `cancelUpcomingBookings` runs after, one booking per transaction,
 * each with its players' notice. A failure part-way leaves the rest to cancel
 * and is counted, not thrown: the club is already offline, and one bad row
 * must not leave every later player believing they still have a court.
 */

export class ClubNotFoundError extends Error {
  constructor() {
    super('Club not found');
    this.name = 'ClubNotFoundError';
  }
}

/** CLOSED is final, and a change to the status the club already has is refused. */
export class ClubStatusChangeError extends Error {
  constructor(
    readonly from: TenantStatus,
    readonly to: TenantStatus,
  ) {
    super(`A club cannot go from ${from} to ${to}`);
    this.name = 'ClubStatusChangeError';
  }
}

const ALLOWED: Record<TenantStatus, readonly TenantStatus[]> = {
  ACTIVE: ['SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export function mayChangeStatus(from: TenantStatus, to: TenantStatus): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Move the club's status, inside the caller's transaction (the platform
 * binding, which has already checked TENANT_SUSPEND, the step-up and the
 * reason, and written the platform's audit row). Writes the club's own audit
 * row too, so the club's history shows when it went offline and why.
 */
export async function setClubStatus(
  db: PrismaClient,
  input: { tenantId: string; to: TenantStatus; reason: string; actorUserId: string },
): Promise<{ from: TenantStatus; to: TenantStatus; slug: string }> {
  // Locked, so two moderators' changes serialise and each audit row's "from"
  // is the status the other one left.
  const [locked] = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM venue_org WHERE id = ${input.tenantId} FOR UPDATE`;
  if (!locked) throw new ClubNotFoundError();

  const club = await db.venueOrg.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: { status: true, slug: true },
  });
  if (!mayChangeStatus(club.status, input.to)) {
    throw new ClubStatusChangeError(club.status, input.to);
  }

  await db.venueOrg.update({ where: { id: input.tenantId }, data: { status: input.to } });

  await appendAuditEntry(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: 'USER',
    entity: 'VenueOrg',
    entityId: input.tenantId,
    action: AUDIT_ACTIONS.CLUB_STATUS_CHANGED,
    details: `Club status ${club.status} → ${input.to}`,
    detailsJson: {
      category: 'club',
      summary: 'The platform changed the club status',
      source: 'platform',
      reason: input.reason,
      before: club.status,
      after: input.to,
    },
  });

  return { from: club.status, to: input.to, slug: club.slug };
}

/** At most this many bookings per run; a run reports how many are left. */
export const MAX_CANCELLED_PER_RUN = 2_000;

/**
 * Cancel every upcoming booking of a club that has just gone offline, as the
 * club (the players are told it was the club, which it is), each with notice.
 * Upcoming: PENDING or CONFIRMED and not yet started. A booking already under
 * way is left to finish.
 */
export async function cancelUpcomingBookings(input: {
  tenantId: string;
  reason: string;
  now?: Date;
}): Promise<{ cancelled: number; failed: number; remaining: number }> {
  const now = input.now ?? new Date();

  const upcoming = await runInTenantContext(input.tenantId, (db) =>
    db.booking.findMany({
      where: {
        tenantId: input.tenantId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startTs: { gt: now },
      },
      select: { id: true },
      orderBy: { startTs: 'asc' },
      take: MAX_CANCELLED_PER_RUN + 1,
    }),
  );
  const batch = upcoming.slice(0, MAX_CANCELLED_PER_RUN);

  let cancelled = 0;
  let failed = 0;
  for (const b of batch) {
    try {
      await runInTenantContext(
        input.tenantId,
        (db) =>
          cancelBooking(db, input.tenantId, {
            bookingId: b.id,
            actor: 'STAFF',
            cancelledByUserId: null,
            reason: input.reason,
            now,
          }),
        undefined,
        { isolationLevel: 'Serializable' },
      );
      cancelled += 1;
    } catch (err) {
      failed += 1;
      logger.error('club offline: booking not cancelled', {
        component: 'club-status',
        bookingId: b.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // Never throws: the booking is cancelled either way.
    await notifyBookingCancelled({
      tenantId: input.tenantId,
      bookingId: b.id,
      by: 'CLUB',
      actorUserId: null,
      now,
    });
  }

  // Weekly series: cut at today, so nothing more is generated for them.
  await runInTenantContext(input.tenantId, (db) =>
    db.bookingSeries.updateMany({
      where: {
        tenantId: input.tenantId,
        OR: [{ cancelledFrom: null }, { cancelledFrom: { gt: now } }],
      },
      data: { cancelledFrom: now },
    }),
  );

  return { cancelled, failed, remaining: Math.max(0, upcoming.length - batch.length) };
}
