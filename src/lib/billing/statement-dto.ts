import type {
  ClubFeeOverviewRow,
  ClubStatement,
  StatementTotals,
} from '@/app-layer/usecases/club-fees';
import { bpsToPercent } from '@/lib/billing/club-fee';

/**
 * A statement as it crosses a boundary (#372): the v1 JSON, and the props the
 * admin page hands its client components. Plain data only: no Date, no
 * Decimal. Timestamps are RFC 3339 without fractional seconds, as every v1
 * timestamp is (`rfc3339` in src/app/api/v1/_lib/dto.ts says why: Swift's
 * default ISO 8601 decoder refuses them). Percentages are strings with two
 * decimals ("12.50"), so no client ever does float arithmetic on a rate.
 *
 * No directive: the API routes and the server pages both call these.
 */

const rfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface StatementTotalsDto {
  bookingsPlayed: number;
  revenueCents: number;
  feeCents: number;
  lineCount: number;
}

export interface StatementLineDto {
  id: string;
  kind: 'CHARGE' | 'REVERSAL';
  bookingId: string;
  venueName: string;
  courtName: string;
  startsAt: string;
  priceCents: number;
  feePercent: string;
  freePeriod: boolean;
  feeCents: number;
  recordedAt: string;
}

export interface ClubStatementDto {
  club: { id: string; slug: string; name: string };
  month: string;
  timeZone: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  feePercent: string;
  feeStartsOn: string;
  freePeriod: 'all' | 'part' | 'none';
  totals: StatementTotalsDto;
  lines: StatementLineDto[];
  linesTruncated: boolean;
}

const totalsDto = (t: StatementTotals): StatementTotalsDto => ({ ...t });

export function toClubStatementDto(s: ClubStatement): ClubStatementDto {
  return {
    club: s.club,
    month: s.month,
    timeZone: s.timeZone,
    periodStart: rfc3339(s.periodStart),
    periodEnd: rfc3339(s.periodEnd),
    currency: s.currency,
    feePercent: s.terms.feePercent,
    feeStartsOn: s.terms.feeStartsOn,
    freePeriod: s.freePeriod,
    totals: totalsDto(s.totals),
    lines: s.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      bookingId: l.bookingId,
      venueName: l.venueName,
      courtName: l.courtName,
      startsAt: rfc3339(l.startsAt),
      priceCents: l.priceCents,
      feePercent: bpsToPercent(l.feeBps),
      freePeriod: l.freePeriod,
      feeCents: l.feeCents,
      recordedAt: rfc3339(l.recordedAt),
    })),
    linesTruncated: s.linesTruncated,
  };
}

export interface FeeOverviewRowDto {
  club: { id: string; slug: string; name: string; status: string };
  currency: string;
  feePercent: string;
  feeStartsOn: string;
  freePeriod: 'all' | 'part' | 'none';
  totals: StatementTotalsDto;
}

export function toFeeOverviewRowDto(r: ClubFeeOverviewRow): FeeOverviewRowDto {
  return {
    club: r.club,
    currency: r.currency,
    feePercent: r.terms.feePercent,
    feeStartsOn: r.terms.feeStartsOn,
    freePeriod: r.freePeriod,
    totals: totalsDto(r.totals),
  };
}
