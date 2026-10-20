import { Prisma, type PrismaClient } from '@prisma/client';

import { CourtNotFoundError, VenueNotFoundError } from '@/app-layer/usecases/courts';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { parseOutline, type PlanPoint } from '@/lib/venues/plan';

/**
 * The club's own plan (#626): where each of a venue's courts lies, as the club
 * says. OpenStreetMap gives a start (#624); the club moves, turns, resizes or
 * draws a court, or takes it off the plan, and from then on the outline is the
 * club's (`planSource: CLUB`), which the importer never overwrites.
 *
 * Staff with `courts.manage`, in the club's own tenant context (the caller
 * binds), and every court changed is an audit row with its outline before and
 * after, as every other court change is (`courts.ts`).
 */

export class InvalidOutlineError extends Error {
  constructor(readonly courtId: string) {
    super(`The outline for court ${courtId} is not a polygon the plan can draw.`);
    this.name = 'InvalidOutlineError';
  }
}

/** One court's new place: an outline, or null for "not on the plan". */
export interface PlanChange {
  resourceId: string;
  outline: PlanPoint[] | null;
}

/** The venue, its courts with their outlines, and the plan's other shapes. */
export async function loadVenuePlanEditor(db: PrismaClient, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: {
      id: true,
      name: true,
      resources: {
        where: { tenantId, status: { not: 'CLOSED' } },
        orderBy: { name: 'asc' },
        take: 100,
        select: { id: true, name: true, sport: true, planOutline: true, planSource: true },
      },
      planFeatures: {
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: { kind: true, outline: true },
      },
    },
  });
  if (!venue) return null;
  return {
    id: venue.id,
    name: venue.name,
    courts: venue.resources.map((r) => {
      const outline = parseOutline(r.planOutline);
      return {
        resourceId: r.id,
        name: r.name,
        sport: r.sport as string,
        outline,
        source: outline ? r.planSource : null,
      };
    }),
    features: venue.planFeatures.flatMap((f) => {
      const outline = parseOutline(f.outline);
      return outline ? [{ kind: f.kind, outline }] : [];
    }),
  };
}

/**
 * Put each changed court where the club says, or take it off the plan. All or
 * nothing: a court that is not this venue's, or an outline that is not a sane
 * polygon, refuses the whole save before anything is written.
 */
export async function saveVenuePlan(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  venueId: string,
  changes: PlanChange[],
) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  });
  if (!venue) throw new VenueNotFoundError();

  const ids = [...new Set(changes.map((c) => c.resourceId))];
  const courts = await db.resource.findMany({
    where: { id: { in: ids }, tenantId, venueId },
    select: { id: true, name: true, planOutline: true, planSource: true },
    take: ids.length,
  });
  if (courts.length !== ids.length) throw new CourtNotFoundError();
  const byId = new Map(courts.map((c) => [c.id, c]));

  const parsed = changes.map((c) => {
    if (c.outline === null) return { ...c, outline: null };
    const outline = parseOutline(c.outline);
    if (!outline) throw new InvalidOutlineError(c.resourceId);
    return { ...c, outline };
  });

  for (const change of parsed) {
    const before = byId.get(change.resourceId)!;
    await db.resource.update({
      where: { id: change.resourceId },
      data: change.outline
        ? { planOutline: change.outline, planSource: 'CLUB', planOsmWayId: null }
        : { planOutline: Prisma.DbNull, planSource: null, planOsmWayId: null },
    });
    await appendAuditEntry(db, {
      tenantId,
      actorUserId,
      entity: 'Resource',
      entityId: change.resourceId,
      action: AUDIT_ACTIONS.COURT_PLAN_CHANGED,
      details: change.outline
        ? `Court "${before.name}" placed on the venue plan`
        : `Court "${before.name}" taken off the venue plan`,
      detailsJson: {
        category: 'config',
        summary: 'Court plan changed',
        before: { outline: before.planOutline, source: before.planSource },
        after: { outline: change.outline, source: change.outline ? 'CLUB' : null },
      },
    });
  }
  return { saved: parsed.length };
}
