import { Prisma, type ClubFeeLineKind, type PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { RESOURCE_TYPES, resourceNouns, type ResourceNouns } from '@/lib/sports/resource-kinds';
import {
  bpsToPercent,
  chargeFor,
  effectiveFeeStartsOn,
  FEE_TIME_ZONE,
  freePeriodCover,
  isInFreePeriod,
  monthBounds,
  percentToBps,
  statementMonthOf,
  type FreePeriodCover,
} from '@/lib/billing/club-fee';

/**
 * The club fee ledger and the statements summed from it (#372).
 *
 * ═══ WHERE A LINE IS WRITTEN ═══
 *
 *   CHARGE    `completeEndedBookings`, in the same transaction that moves the
 *             booking to COMPLETED. ONLINE bookings only.
 *   CHARGE    `recordMissingFeeCharges`, every sweep run and from the backfill
 *             script: a COMPLETED online booking with no charge yet. That is a
 *             booking completed before this existed, or by the previous image
 *             after a rollback.
 *   REVERSAL  `markNoShow`, when staff overturn a COMPLETED booking, in the
 *             same transaction as the status change.
 *
 * Every write is `INSERT … ON CONFLICT DO NOTHING` on (bookingId, kind), so
 * running any of them twice writes nothing the second time.
 *
 * ═══ A RACE WITH A CANCELLATION OR A NO-SHOW ═══
 *
 * A charge is written only for the ids the sweep's own UPDATE returned, and
 * that UPDATE re-states `status = 'CONFIRMED'`: a booking cancelled (or marked
 * a no-show) first is skipped by Postgres and gets no line. A no-show marked
 * second locks the row `FOR UPDATE`, which waits for the sweep to commit and
 * then reads COMPLETED, and the charge it reverses was committed with it.
 * Cancelling never reaches a COMPLETED booking (`cancelBooking` accepts only
 * PENDING and CONFIRMED).
 */

/** One run's ceiling for the catch-up, like the sweep's own. */
export const MISSING_CHARGES_PER_RUN = 500;

/**
 * How far back the sweep's catch-up looks. A rollback window is a release, so a
 * week is generous; the backfill script looks at all of history.
 */
export const CATCH_UP_LOOKBACK_DAYS = 7;

/** A month of one club's lines is bounded by its courts; this is the read's ceiling. */
export const STATEMENT_LINE_CAP = 10_000;

interface ClubTerms {
  feePercent: Prisma.Decimal;
  feeStartsOn: Date | null;
  createdAt: Date;
}

/** A club's rate in basis points. A stored value the CHECK admits always parses. */
function termsBps(terms: Pick<ClubTerms, 'feePercent'>): number {
  const bps = percentToBps(terms.feePercent.toString());
  if (bps === null) throw new Error(`venue_org.feePercent ${terms.feePercent} is not a valid fee`);
  return bps;
}

/**
 * Write the CHARGE line for each of `bookingIds` that is COMPLETED and ONLINE.
 *
 * Takes the handle the caller bound: the sweep's cross-tenant one, or the
 * backfill's. Ids that are not online or not completed are skipped, which is
 * how desk bookings carry no fee without a second rule anywhere.
 *
 * The rate and the free period are read NOW, once per club, and copied onto
 * the line: a later change to the club's terms never touches it.
 */
export async function recordFeeCharges(
  db: PrismaClient,
  bookingIds: readonly string[],
): Promise<number> {
  if (bookingIds.length === 0) return 0;

  // guardrail-allow: cross-tenant — the caller's ids span clubs (the sweep) and
  // each row is stamped with its own tenant below.
  const bookings = await db.booking.findMany({
    where: { id: { in: [...bookingIds] }, status: 'COMPLETED', channel: 'ONLINE' },
    select: {
      id: true,
      tenantId: true,
      startTs: true,
      totalCents: true,
      currency: true,
      resource: { select: { id: true, name: true, venue: { select: { id: true, name: true } } } },
    },
    take: bookingIds.length,
  });
  if (bookings.length === 0) return 0;

  const tenantIds = [...new Set(bookings.map((b) => b.tenantId))];
  // guardrail-allow: cross-tenant — the terms of exactly the clubs above.
  const orgs = await db.venueOrg.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, feePercent: true, feeStartsOn: true, createdAt: true },
    take: tenantIds.length,
  });
  const termsOf = new Map(orgs.map((o) => [o.id, o]));

  const data: Prisma.ClubFeeLineCreateManyInput[] = [];
  for (const b of bookings) {
    const terms = termsOf.get(b.tenantId);
    if (!terms) continue;
    const startsOn = effectiveFeeStartsOn(terms.feeStartsOn, terms.createdAt);
    data.push({
      tenantId: b.tenantId,
      bookingId: b.id,
      kind: 'CHARGE',
      venueId: b.resource.venue.id,
      venueName: b.resource.venue.name,
      resourceId: b.resource.id,
      courtName: b.resource.name,
      bookingStartTs: b.startTs,
      statementMonth: statementMonthOf(b.startTs),
      priceCents: b.totalCents,
      currency: b.currency,
      ...chargeFor({
        priceCents: b.totalCents,
        bps: termsBps(terms),
        free: isInFreePeriod(b.startTs, startsOn),
      }),
    });
  }

  const written = await db.clubFeeLine.createMany({ data, skipDuplicates: true });
  return written.count;
}

/**
 * Charges for COMPLETED online bookings that ended in the last
 * `lookbackDays` and have none: the sweep's self-repair, and with
 * `lookbackDays: null` the backfill of all history.
 *
 * Returns how many lines it wrote and whether it stopped at `limit`.
 */
export async function recordMissingFeeCharges(
  db: PrismaClient,
  opts: { now?: Date; lookbackDays?: number | null; limit?: number } = {},
): Promise<{ found: number; written: number; truncated: boolean }> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? MISSING_CHARGES_PER_RUN, MISSING_CHARGES_PER_RUN);
  const lookback = opts.lookbackDays === undefined ? CATCH_UP_LOOKBACK_DAYS : opts.lookbackDays;
  const since =
    lookback === null ? new Date(0) : new Date(now.getTime() - lookback * 24 * 3_600_000);

  // guardrail-allow: cross-tenant — the whole platform, by design. Served by
  // booking_status_endTs_idx (P35) and the (bookingId, kind) unique index.
  const missing = await db.$queryRaw<Array<{ id: string }>>`
    SELECT b.id
      FROM booking b
     WHERE b.status = 'COMPLETED'
       AND b.channel = 'ONLINE'
       AND b."endTs" >= ${since}
       AND b."endTs" < ${now}
       AND NOT EXISTS (
             SELECT 1 FROM club_fee_line l
              WHERE l."bookingId" = b.id AND l.kind = 'CHARGE')
     ORDER BY b."endTs" ASC
     LIMIT ${limit}`;

  const written = await recordFeeCharges(
    db,
    missing.map((m) => m.id),
  );
  return { found: missing.length, written, truncated: missing.length === limit };
}

/**
 * Undo a booking's charge: staff said a COMPLETED booking was not played.
 *
 * The REVERSAL is the charge negated, line for line, and lands in the
 * statement month of `now`, the month the correction was made. The month the
 * booking was played may already be invoiced; its statement must read the same
 * tomorrow as it did when the invoice was written, so the credit is carried by
 * the next one. Within the same month the two lines simply net to zero.
 *
 * Runs inside the caller's binding (the no-show's tenant transaction). No
 * charge, nothing to reverse: a no-show before completion, a desk booking, or
 * an online booking completed by an image that wrote no line and was never
 * caught up (it will not be now either, being NO_SHOW).
 */
export async function reverseFeeCharge(
  db: PrismaClient,
  tenantId: string,
  bookingId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const charge = await db.clubFeeLine.findFirst({
    where: { tenantId, bookingId, kind: 'CHARGE' },
  });
  if (!charge) return false;

  const written = await db.clubFeeLine.createMany({
    data: [
      {
        tenantId,
        bookingId,
        kind: 'REVERSAL',
        venueId: charge.venueId,
        venueName: charge.venueName,
        resourceId: charge.resourceId,
        courtName: charge.courtName,
        bookingStartTs: charge.bookingStartTs,
        statementMonth: statementMonthOf(now),
        // Negated, never recomputed: the reversal must cancel exactly what was
        // charged, at the rate and rounding it was charged with.
        priceCents: -charge.priceCents,
        feeBps: charge.feeBps,
        freePeriod: charge.freePeriod,
        feeCents: -charge.feeCents,
        currency: charge.currency,
      },
    ],
    skipDuplicates: true,
  });
  return written.count > 0;
}

// ═══ STATEMENTS ═══════════════════════════════════════════════════════════

export interface StatementLine {
  id: string;
  kind: ClubFeeLineKind;
  bookingId: string;
  venueName: string;
  courtName: string;
  startsAt: Date;
  priceCents: number;
  feeBps: number;
  freePeriod: boolean;
  feeCents: number;
  recordedAt: Date;
}

export interface StatementTotals {
  /** Charges minus reversals: online bookings played, net of corrections. */
  bookingsPlayed: number;
  /** The court price summed over the lines (reversals negative). */
  revenueCents: number;
  /** The fee summed over the lines, each already rounded. */
  feeCents: number;
  lineCount: number;
}

export interface ClubTermsView {
  feeBps: number;
  feePercent: string;
  /** The first day the fee is charged, at the club. */
  feeStartsOn: string;
}

export interface ClubStatement {
  club: { id: string; slug: string; name: string };
  /** The month the club was created in, at the club: where a month picker starts. */
  clubSinceMonth: string;
  month: string;
  timeZone: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  /** The club's terms TODAY. Each line carries the rate it was charged at. */
  terms: ClubTermsView;
  /** How much of this month the free period covers, on today's terms. */
  freePeriod: FreePeriodCover;
  totals: StatementTotals;
  lines: StatementLine[];
  /** True when the month had more lines than `STATEMENT_LINE_CAP`; the totals are still whole. */
  linesTruncated: boolean;
  /**
   * What the court column is called (P51, #454): `track` at a karting club,
   * `pitch` at a football one, a list (`courtPitch`) at one with several, else
   * `court`. From the club's resources, archived ones included, since a
   * statement can hold lines for them.
   */
  courtNouns: ResourceNouns;
}

export function termsView(org: ClubTerms): ClubTermsView {
  const feeBps = termsBps(org);
  return {
    feeBps,
    feePercent: bpsToPercent(feeBps),
    feeStartsOn: effectiveFeeStartsOn(org.feeStartsOn, org.createdAt),
  };
}

/** Sum lines grouped by kind into the totals a statement reports. */
function totalsFrom(
  groups: Array<{
    kind: ClubFeeLineKind;
    _count: { _all: number };
    _sum: { priceCents: number | null; feeCents: number | null };
  }>,
): StatementTotals {
  const totals: StatementTotals = { bookingsPlayed: 0, revenueCents: 0, feeCents: 0, lineCount: 0 };
  for (const g of groups) {
    totals.lineCount += g._count._all;
    totals.bookingsPlayed += g.kind === 'CHARGE' ? g._count._all : -g._count._all;
    totals.revenueCents += g._sum.priceCents ?? 0;
    totals.feeCents += g._sum.feeCents ?? 0;
  }
  return totals;
}

/**
 * One club's statement for `month` (`YYYY-MM`, at the club).
 *
 * Takes a handle bound to that club (the admin page, the club API) or a
 * platform one (the owner's overview); `tenantId` is in every WHERE either way.
 * Returns null for a club that does not exist.
 */
export async function loadClubStatement(
  db: PrismaClient,
  tenantId: string,
  month: string,
): Promise<ClubStatement | null> {
  const org = await db.venueOrg.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      slug: true,
      name: true,
      currency: true,
      feePercent: true,
      feeStartsOn: true,
      createdAt: true,
    },
  });
  if (!org) return null;

  const [rows, groups, types] = await Promise.all([
    db.clubFeeLine.findMany({
      where: { tenantId, statementMonth: month },
      orderBy: [{ bookingStartTs: 'asc' }, { kind: 'asc' }, { id: 'asc' }],
      take: STATEMENT_LINE_CAP + 1,
    }),
    db.clubFeeLine.groupBy({
      by: ['kind'],
      where: { tenantId, statementMonth: month },
      _count: { _all: true },
      _sum: { priceCents: true, feeCents: true },
      orderBy: { kind: 'asc' },
    }),
    db.resource.findMany({
      where: { tenantId },
      select: { resourceType: true },
      distinct: ['resourceType'],
      orderBy: { resourceType: 'asc' },
      take: RESOURCE_TYPES.length,
    }),
  ]);

  const terms = termsView(org);
  const { start, end } = monthBounds(month);

  return {
    club: { id: org.id, slug: org.slug, name: org.name },
    clubSinceMonth: statementMonthOf(org.createdAt),
    month,
    timeZone: FEE_TIME_ZONE,
    periodStart: start,
    periodEnd: end,
    currency: org.currency,
    terms,
    freePeriod: freePeriodCover(month, terms.feeStartsOn),
    totals: totalsFrom(groups),
    lines: rows.slice(0, STATEMENT_LINE_CAP).map((l) => ({
      id: l.id,
      kind: l.kind,
      bookingId: l.bookingId,
      venueName: l.venueName,
      courtName: l.courtName,
      startsAt: l.bookingStartTs,
      priceCents: l.priceCents,
      feeBps: l.feeBps,
      freePeriod: l.freePeriod,
      feeCents: l.feeCents,
      recordedAt: l.createdAt,
    })),
    linesTruncated: rows.length > STATEMENT_LINE_CAP,
    courtNouns: resourceNouns(types.map((r) => r.resourceType)),
  };
}

export interface ClubFeeOverviewRow {
  club: { id: string; slug: string; name: string; status: string };
  currency: string;
  terms: ClubTermsView;
  freePeriod: FreePeriodCover;
  totals: StatementTotals;
}

/** The overview's ceiling: the pilot has a handful of clubs; the platform page is not paged yet. */
export const OVERVIEW_CLUB_CAP = 500;

/**
 * Every club's totals for `month`, for the owner to invoice from: one query for
 * the clubs and one grouped sum for their lines. Clubs with no lines are listed
 * at zero, so a club that had no online bookings is visibly zero rather than
 * missing.
 *
 * Cross-tenant: the caller binds a platform handle.
 */
export async function loadFeeOverview(
  db: PrismaClient,
  month: string,
): Promise<{ rows: ClubFeeOverviewRow[]; truncated: boolean }> {
  // guardrail-allow: cross-tenant — every club, for the platform overview.
  const orgs = await db.venueOrg.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      currency: true,
      feePercent: true,
      feeStartsOn: true,
      createdAt: true,
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: OVERVIEW_CLUB_CAP + 1,
  });
  const clubs = orgs.slice(0, OVERVIEW_CLUB_CAP);

  // guardrail-allow: cross-tenant — the month's lines of the clubs above.
  const groups = await db.clubFeeLine.groupBy({
    by: ['tenantId', 'kind'],
    where: { statementMonth: month, tenantId: { in: clubs.map((c) => c.id) } },
    _count: { _all: true },
    _sum: { priceCents: true, feeCents: true },
    orderBy: [{ tenantId: 'asc' }, { kind: 'asc' }],
  });
  const byClub = new Map<string, typeof groups>();
  for (const g of groups) byClub.set(g.tenantId, [...(byClub.get(g.tenantId) ?? []), g]);

  return {
    rows: clubs.map((c) => {
      const terms = termsView(c);
      return {
        club: { id: c.id, slug: c.slug, name: c.name, status: c.status },
        currency: c.currency,
        terms,
        freePeriod: freePeriodCover(month, terms.feeStartsOn),
        totals: totalsFrom(byClub.get(c.id) ?? []),
      };
    }),
    truncated: orgs.length > OVERVIEW_CLUB_CAP,
  };
}

// ═══ SETTING THE TERMS ════════════════════════════════════════════════════

export class ClubNotFoundError extends Error {
  readonly code = 'CLUB_NOT_FOUND';
  constructor() {
    super('No such club');
    this.name = 'ClubNotFoundError';
  }
}

/**
 * Set a club's fee and the day its free period ends, from the platform.
 *
 * The caller has already authorised and audited the request on the platform
 * side (`asPlatformAdmin`, CLUB_FEE_MANAGE, step-up). This also writes the
 * change into the CLUB's own audit log, with the values before and after, so
 * the club's history shows when its terms moved and who moved them.
 *
 * Only lines written AFTER this commit see the new terms; every line already
 * written keeps the rate and free period it was charged with.
 */
export async function setClubFeeTerms(
  db: PrismaClient,
  input: {
    tenantId: string;
    feeBps: number;
    feeStartsOn: string;
    actorUserId: string;
    reason: string;
  },
): Promise<{ before: ClubTermsView; after: ClubTermsView; changed: boolean }> {
  // Locked, so two owners' edits serialise and each audit row's "before" is
  // the value the other one left.
  const [locked] = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM venue_org WHERE id = ${input.tenantId} FOR UPDATE`;
  if (!locked) throw new ClubNotFoundError();

  const org = await db.venueOrg.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: { feePercent: true, feeStartsOn: true, createdAt: true },
  });
  const before = termsView(org);

  const feePercent = new Prisma.Decimal(bpsToPercent(input.feeBps));
  const feeStartsOn = new Date(`${input.feeStartsOn}T00:00:00Z`);
  const after = termsView({ feePercent, feeStartsOn, createdAt: org.createdAt });
  const changed = before.feeBps !== after.feeBps || before.feeStartsOn !== after.feeStartsOn;
  if (!changed) return { before, after, changed };

  await db.venueOrg.update({
    where: { id: input.tenantId },
    data: { feePercent, feeStartsOn },
  });

  await appendAuditEntry(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: 'USER',
    entity: 'VenueOrg',
    entityId: input.tenantId,
    action: AUDIT_ACTIONS.CLUB_FEE_TERMS_CHANGED,
    details: `Club fee set to ${after.feePercent}%, charged from ${after.feeStartsOn}`,
    detailsJson: {
      category: 'billing',
      summary: 'The platform changed the club fee terms',
      source: 'platform',
      reason: input.reason,
      before: { feePercent: before.feePercent, feeStartsOn: before.feeStartsOn },
      after: { feePercent: after.feePercent, feeStartsOn: after.feeStartsOn },
    },
  });

  return { before, after, changed };
}
