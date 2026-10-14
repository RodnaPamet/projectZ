import type { PrismaClient } from '@prisma/client';

import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { getResourceForBooking } from '@/app-layer/repositories/booking';
import { quoteBooking } from '@/app-layer/usecases/availability';
import { createBooking } from '@/app-layer/usecases/booking';
import {
  lockTournament,
  notFound,
  playersOf,
  TournamentDrawError,
} from '@/app-layer/usecases/tournament-draw';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { RateLimitedError } from '@/lib/errors/types';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * A LEAGUE MATCH PLACED BY ITS PLAYERS (#591; decisions 62, 63 on #591).
 *
 * Either side of a ready league match proposes a court and a time. The
 * proposal is a booking in the proposer's name at the court's own price, paid
 * at the club like any booking (62), held as PENDING so nobody else takes the
 * court while the other side decides (63):
 *
 *   accept     someone on the other side: the booking is CONFIRMED and the
 *              match is on the diary, as if the club had placed it.
 *   decline    someone on the other side, or the proposer taking it back: the
 *              hold is released and the match can be placed again.
 *   no answer  the hold lapses at `until` and the expiry sweep releases it.
 *
 * The hold lasts a day, and ends an hour before the start at the latest; a
 * proposal starts two hours from now at the earliest, so there is time to
 * answer. The club can still place the match itself, which replaces a
 * proposal.
 */

/** Proposals hold courts: a player cannot hold the club's evening by trying every slot. */
const PROPOSE_LIMIT: RateLimitConfig = { maxAttempts: 20, windowMs: 3_600_000 };

/** The earliest a proposed match starts: time for the other side to answer. */
export const PROPOSAL_LEAD_MS = 2 * 3_600_000;
const HOLD_MS = 24 * 3_600_000;
const HOLD_ENDS_BEFORE_START_MS = 3_600_000;

/** How long a proposal holds the court: a day, and an hour before the start at the latest. */
export function proposalHoldUntil(now: Date, startTs: Date): Date {
  return new Date(Math.min(now.getTime() + HOLD_MS, startTs.getTime() - HOLD_ENDS_BEFORE_START_MS));
}

interface MatchForPlayers {
  id: string;
  tenantId: string;
  tournamentId: string;
  status: string;
  bookingId: string | null;
  /** The players of side A, then of side B. */
  sides: [string[], string[]];
}

async function matchForPlayers(db: PrismaClient, matchId: string): Promise<MatchForPlayers> {
  const m = await db.tournamentMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      tenantId: true,
      tournamentId: true,
      status: true,
      bookingId: true,
      entryAId: true,
      entryBId: true,
    },
  });
  if (!m || !m.entryAId || !m.entryBId) throw notFound();
  const entries = await db.tournamentEntry.findMany({
    where: { tenantId: m.tenantId, id: { in: [m.entryAId, m.entryBId] } },
    select: { id: true, playerUserId: true, partnerUserId: true },
    take: 2,
  });
  const of = (id: string) => {
    const e = entries.find((x) => x.id === id);
    return e ? playersOf(e) : [];
  };
  return { ...m, sides: [of(m.entryAId), of(m.entryBId)] };
}

const sideOf = (m: MatchForPlayers, userId: string | null): 0 | 1 | null =>
  !userId ? null : m.sides[0].includes(userId) ? 0 : m.sides[1].includes(userId) ? 1 : null;

/**
 * One side proposes a court and a time for its league match (62, 63). The
 * court must be at the tournament's venue and free; the price is the court's.
 */
export async function proposeMatchTime(
  actor: { userId: string },
  matchId: string,
  input: { resourceId: string; startTs: Date; durationMinutes: number },
  now: Date = new Date(),
): Promise<{ tournamentId: string; bookingId: string }> {
  if (!isRateLimitBypassed()) {
    const r = await checkRateLimit(`league-propose:u:${actor.userId}`, PROPOSE_LIMIT);
    if (!r.allowed) throw new RateLimitedError('Too many proposals. Try again later.');
  }
  // guardrail-allow: cross-tenant — a player's own league match, found by its
  // id; they are not a member of the club. Every write states its tenantId.
  return runAsSuperuser(async (db) => {
    const m = await matchForPlayers(db, matchId);
    // Someone not on the match learns nothing about it.
    if (sideOf(m, actor.userId) === null) throw notFound();
    const t = await lockTournament(db, m.tenantId, m.tournamentId);
    if (t.format !== 'LEAGUE' || t.status !== 'IN_PROGRESS' || m.status !== 'READY') {
      throw new TournamentDrawError(
        'TOURNAMENT_MATCH_NOT_READY',
        409,
        'Only a ready league match is placed by its players.',
      );
    }
    if (m.bookingId) {
      const old = await db.booking.findFirst({
        where: { id: m.bookingId, tenantId: m.tenantId },
        select: { status: true, expiresAt: true },
      });
      const held = old?.status === 'PENDING' && (!old.expiresAt || old.expiresAt > now);
      if (old?.status === 'CONFIRMED' || held) {
        throw new TournamentDrawError(
          'TOURNAMENT_MATCH_PLACED',
          409,
          'The match is already on a court, or has a time waiting for an answer.',
        );
      }
    }
    if (input.startTs.getTime() < now.getTime() + PROPOSAL_LEAD_MS) {
      throw new TournamentDrawError(
        'TOURNAMENT_INVALID',
        400,
        'A proposed match starts two hours from now at the earliest.',
        { field: 'startTs' },
      );
    }

    // The court, by the court booking's own rules and at its own price (62).
    const resource = await getResourceForBooking(db, m.tenantId, input.resourceId);
    if (!resource || resource.venue.id !== t.venueId || resource.venue.status !== 'ACTIVE') {
      throw new TournamentDrawError(
        'TOURNAMENT_INVALID',
        400,
        'The court is not at the tournament’s venue.',
        { field: 'resourceId' },
      );
    }
    const endTs = new Date(input.startTs.getTime() + input.durationMinutes * 60_000);
    const priceCents = quoteBooking({
      startTs: input.startTs,
      endTs,
      timezone: resource.venue.timezone,
      basePriceCents: resource.basePriceCents,
      minBookingMinutes: resource.minBookingMinutes,
      maxBookingMinutes: resource.maxBookingMinutes,
      slotStepMinutes: resource.slotStepMinutes,
      windows: resource.availability.map((w) => ({
        dayOfWeek: w.dayOfWeek,
        openMinutes: minutesFromTimeColumn(w.openTime),
        closeMinutes: minutesFromTimeColumn(w.closeTime),
        effectiveFrom: w.effectiveFrom,
        effectiveTo: w.effectiveTo,
        exceptionDate: w.exceptionDate,
      })),
      pricingRules: resource.pricingRules.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        conditionsJson: r.conditionsJson as never,
        multiplier: r.multiplier as never,
        fixedPriceCents: r.fixedPriceCents,
      })),
    }).priceCents;

    const created = await createBooking(db, m.tenantId, {
      resourceId: input.resourceId,
      startTs: input.startTs,
      endTs,
      totalCents: priceCents,
      // With the booking it follows: a slot proposed before and declined is a
      // new booking, never the released one replayed.
      idempotencyKey: `tprop:${m.id}:${m.bookingId ?? '-'}:${input.startTs.getTime()}:${input.resourceId}`,
      bookedByUserId: actor.userId,
      notes: t.name,
      channel: 'ONLINE',
      holdUntil: proposalHoldUntil(now, input.startTs),
      now,
    });
    if (!created.idempotentReplay) {
      // The proposer is the booker, position 1; everyone else on the match after.
      const others = m.sides.flat().filter((u) => u !== actor.userId);
      await db.bookingParticipant.createMany({
        data: others.map((userId, i) => ({
          tenantId: m.tenantId,
          bookingId: created.bookingId,
          userId,
          position: i + 2,
        })),
        skipDuplicates: true,
      });
    }
    await db.tournamentMatch.updateMany({
      where: { id: m.id, tenantId: m.tenantId },
      data: { bookingId: created.bookingId },
    });
    return { tournamentId: m.tournamentId, bookingId: created.bookingId };
  });
}

export type ProposalAnswer = 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';

/**
 * The other side accepts or declines the proposed time; the proposer may take
 * it back (63). Accepted, the booking is confirmed; otherwise the court is
 * free again.
 */
export async function answerMatchTime(
  actor: { userId: string },
  matchId: string,
  accept: boolean,
  now: Date = new Date(),
): Promise<{ tournamentId: string; bookingId: string; answer: ProposalAnswer }> {
  // guardrail-allow: cross-tenant — a player's own league match, found by its
  // id; they are not a member of the club. Every write states its tenantId.
  return runAsSuperuser(async (db) => {
    const m = await matchForPlayers(db, matchId);
    const mine = sideOf(m, actor.userId);
    if (mine === null) throw notFound();
    await lockTournament(db, m.tenantId, m.tournamentId);
    const b = m.bookingId
      ? await db.booking.findFirst({
          where: { id: m.bookingId, tenantId: m.tenantId },
          select: { id: true, status: true, expiresAt: true, bookedByUserId: true },
        })
      : null;
    const proposer = sideOf(m, b?.bookedByUserId ?? null);
    const open =
      m.status === 'READY' &&
      b?.status === 'PENDING' &&
      !!b.expiresAt &&
      b.expiresAt > now &&
      proposer !== null;
    // Only the other side accepts; either side may let the time go.
    if (!open || (accept && proposer === mine)) {
      throw new TournamentDrawError(
        'TOURNAMENT_NO_PROPOSAL',
        409,
        'There is no proposed time for you to answer.',
      );
    }
    const answer: ProposalAnswer = accept
      ? 'ACCEPTED'
      : proposer === mine
        ? 'WITHDRAWN'
        : 'DECLINED';
    const moved = await db.booking.updateMany({
      where: { id: b.id, tenantId: m.tenantId, status: 'PENDING' },
      data: accept
        ? { status: 'CONFIRMED', expiresAt: null }
        : {
            status: 'CANCELLED',
            cancelledAt: now,
            cancellationReasonJson: { reason: `League match time ${answer.toLowerCase()}.` },
          },
    });
    if (moved.count === 0) {
      throw new TournamentDrawError(
        'TOURNAMENT_NO_PROPOSAL',
        409,
        'There is no proposed time for you to answer.',
      );
    }
    await appendAuditEntry(db, {
      tenantId: m.tenantId,
      actorUserId: actor.userId,
      actorType: 'USER',
      entity: 'Booking',
      entityId: b.id,
      action: accept ? AUDIT_ACTIONS.BOOKING_CONFIRMED : AUDIT_ACTIONS.BOOKING_CANCELLED,
      details: accept
        ? 'League match time accepted by the other side'
        : `League match time ${answer.toLowerCase()}: the held court is released`,
      detailsJson: {
        category: 'booking',
        summary: `League match time ${answer.toLowerCase()}`,
        before: { status: 'PENDING' },
        after: { status: accept ? 'CONFIRMED' : 'CANCELLED' },
        tournamentMatchId: m.id,
        source: 'league_proposal',
      },
    });
    return { tournamentId: m.tournamentId, bookingId: b.id, answer };
  });
}
