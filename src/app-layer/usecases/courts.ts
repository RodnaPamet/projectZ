import type { PrismaClient } from '@prisma/client';

import type { CourtCreate, CourtUpdate } from '@/app-layer/schemas/court';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * Creating, editing and retiring a court.
 *
 * ═══ WHY THERE IS NO DELETE ═══
 *
 * A court is referenced by every booking ever made on it, and through those by
 * payments, refunds, check-ins and credit-ledger entries. Deleting the row
 * either fails on a foreign key or, with a cascade, silently destroys the
 * financial record of last season.
 *
 * So retiring a court sets `status: CLOSED`. The list hides it, availability
 * stops generating slots for it, and every historical row still resolves. That
 * is what `archiveCourt` does, and why it is not called `deleteCourt` — a name
 * that promises removal invites somebody to make it true.
 *
 * ═══ WHY EVERY MUTATION WRITES AN AUDIT ENTRY ═══
 *
 * "Who put the price up?" is a question clubs ask, usually after a customer
 * complains. `basePriceCents` has no history of its own, so without the audit
 * row the answer is unavailable — and the row is only useful if it records the
 * BEFORE value, since the after is visible by looking at the court.
 *
 * ═══ THE CALLER BINDS ═══
 *
 * Every function takes `db` and a `tenantId`. The binding is the caller's
 * decision — `runInTenantContext` for anything here — and the explicit
 * `tenantId` is belt and braces, for the day this runs somewhere RLS does not
 * apply. `tenant-isolation-structural` requires it.
 */

export class CourtNotFoundError extends Error {
  constructor() {
    super(
      'No court with that id at this club. Either it does not exist or it belongs to ' +
        'another tenant — the two are deliberately indistinguishable, because telling them ' +
        'apart turns an id field into a cross-club probe.',
    );
    this.name = 'CourtNotFoundError';
  }
}

export class VenueNotFoundError extends Error {
  constructor() {
    super('No venue with that id at this club. A court must belong to one of your own sites.');
    this.name = 'VenueNotFoundError';
  }
}

/** The shape both mutations audit, so before/after compare like with like. */
const AUDITED_FIELDS = {
  name: true,
  sport: true,
  surface: true,
  isIndoor: true,
  capacity: true,
  basePriceCents: true,
  minBookingMinutes: true,
  maxBookingMinutes: true,
  slotStepMinutes: true,
  status: true,
} as const;

export async function createCourt(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  input: CourtCreate,
) {
  // The venue is checked against THIS tenant rather than trusted from the
  // form. Without it, a crafted `venueId` attaches a court to another club's
  // site — `Resource.venueId` has no composite FK to (tenantId, venueId), so
  // nothing at the schema level refuses it.
  const venue = await db.venue.findFirst({
    where: { id: input.venueId, tenantId },
    select: { id: true },
  });
  if (!venue) throw new VenueNotFoundError();

  const court = await db.resource.create({
    data: { tenantId, ...input },
    select: { id: true, ...AUDITED_FIELDS },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'Resource',
    entityId: court.id,
    action: AUDIT_ACTIONS.COURT_CREATED,
    details: `Court "${court.name}" added`,
    detailsJson: { category: 'config', summary: 'Court created', after: court },
  });

  return court;
}

export async function updateCourt(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  courtId: string,
  input: CourtUpdate,
) {
  // Read first, for the BEFORE state. An audit row carrying only the new value
  // answers "what is it now?", which anyone can see by looking.
  const before = await db.resource.findFirst({
    where: { id: courtId, tenantId },
    select: { id: true, ...AUDITED_FIELDS },
  });
  if (!before) throw new CourtNotFoundError();

  const after = await db.resource.update({
    where: { id: courtId },
    data: input,
    select: { id: true, ...AUDITED_FIELDS },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'Resource',
    entityId: courtId,
    action: AUDIT_ACTIONS.COURT_UPDATED,
    details: `Court "${after.name}" updated`,
    detailsJson: { category: 'config', summary: 'Court updated', before, after },
  });

  return after;
}

/**
 * Retire a court, or bring it back.
 *
 * ═══ WHAT THIS DOES NOT DO ═══
 *
 * It does not cancel the bookings already on the court. A club archiving a
 * court mid-season still owes the people who booked it, and silently voiding
 * their reservations — with payments taken — would be the worst possible
 * reading of "archive". Those bookings stay, and stay cancellable through the
 * ordinary path with its ordinary refund policy.
 *
 * The screen has to say so, or an owner will archive a court expecting the
 * diary to clear.
 */
export async function archiveCourt(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  courtId: string,
  opts: { reopen?: boolean } = {},
) {
  const before = await db.resource.findFirst({
    where: { id: courtId, tenantId },
    select: { id: true, name: true, status: true },
  });
  if (!before) throw new CourtNotFoundError();

  const status = opts.reopen ? 'ACTIVE' : 'CLOSED';
  const after = await db.resource.update({
    where: { id: courtId },
    data: { status },
    select: { id: true, name: true, status: true },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'Resource',
    entityId: courtId,
    action: opts.reopen ? AUDIT_ACTIONS.COURT_REOPENED : AUDIT_ACTIONS.COURT_ARCHIVED,
    details: `Court "${after.name}" ${opts.reopen ? 'reopened' : 'archived'}`,
    detailsJson: {
      category: 'config',
      summary: opts.reopen ? 'Court reopened' : 'Court archived',
      before: { status: before.status },
      after: { status: after.status },
    },
  });

  return after;
}

/** How many future bookings a court still carries — what the screen warns with. */
export async function countUpcomingBookings(
  db: PrismaClient,
  tenantId: string,
  courtId: string,
  now: Date,
): Promise<number> {
  return db.booking.count({
    where: {
      tenantId,
      resourceId: courtId,
      startTs: { gte: now },
      status: { in: ['PENDING', 'CONFIRMED'] },
    },
  });
}
