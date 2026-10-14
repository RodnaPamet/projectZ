import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { feeCentsFor, percentToBps, statementMonthOf } from '@/lib/billing/club-fee';
import { createEntryCheckoutSession, refundEntryFee } from '@/lib/billing/tournament-checkout';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { AppError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * A TOURNAMENT ENTRY FEE PAID ONLINE (#581; decisions 41, 42, 64–67).
 *
 *   enter      the entry is written with `paymentDueBy`, and the player is
 *              sent to Stripe's hosted checkout. Until it is paid the club
 *              does not see the entry and it holds no place (HOLDS_PLACE).
 *   paid       the webhook (`checkout.session.completed`) records the payment
 *              and writes playerz's cut on the club's statement (66, 67);
 *              the entry is then an ordinary one, waiting for the club.
 *   lapsed     no payment by the deadline: the entry is withdrawn by nobody.
 *   refund     owed when the club declines the entry, it does not get a place,
 *              the tournament is cancelled (64), or the player withdraws
 *              before entries close (65). Marked in the same transaction as
 *              the change (`refundDueAt`); Stripe is called after the commit,
 *              and again by the sweep, until `refundedAt` is set.
 */

/** A club's prices are in euros (a court's `currency` defaults to EUR); so are its fees. */
export const TOURNAMENT_CURRENCY = 'EUR';
/** How long a checkout page takes payment: Stripe's minimum is 30 minutes. */
export const PAYMENT_WINDOW_MS = 31 * 60_000;
/** A lapse waits this long past the deadline, for a webhook already on its way. */
const LAPSE_GRACE_MS = 5 * 60_000;
const SWEEP_LIMIT = 100;

/**
 * An entry the club sees and that holds a place: no online fee owed, or the
 * fee paid. One awaiting payment is neither.
 */
export const HOLDS_PLACE: Prisma.TournamentEntryWhereInput = {
  OR: [{ paymentDueBy: null }, { paidAt: { not: null } }],
};

export const awaitingPayment = (e: { paymentDueBy: Date | null; paidAt: Date | null }) =>
  !!e.paymentDueBy && !e.paidAt;

/** The fee a tournament takes online, or null when it is free or paid at the club. */
export function onlineFee(t: { feePayment: string; entryFeeCents: number }): number | null {
  return t.feePayment === 'ONLINE' && t.entryFeeCents > 0 ? t.entryFeeCents : null;
}

export class TournamentPaymentError extends AppError {
  constructor(
    code: 'TOURNAMENT_PAYMENT_NOT_DUE' | 'TOURNAMENT_ONLINE_FEE_UNAVAILABLE',
    status: 404 | 409,
    message: string,
  ) {
    super(message, code, status, true);
    this.name = 'TournamentPaymentError';
  }
}

// ─── Checkout ───────────────────────────────────────────────────────────

/**
 * A checkout page for an entry awaiting its fee: on sign-up, or again when
 * the player comes back to pay (a new page each time, with a new deadline).
 * Only the entrant pays. Answers the page's address.
 */
export async function openEntryCheckout(
  userId: string,
  entryId: string,
  now: Date = new Date(),
): Promise<{ checkoutUrl: string; dueBy: Date }> {
  // guardrail-allow: cross-tenant — the caller's own entry by id, with its
  // tournament, its club's connected account, and the caller's email.
  const found = await runAsSuperuser(async (db) => {
    const e = await db.tournamentEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        playerUserId: true,
        paymentDueBy: true,
        paidAt: true,
        tournament: {
          select: {
            id: true,
            name: true,
            status: true,
            entryFeeCents: true,
            feePayment: true,
          },
        },
      },
    });
    if (!e || e.playerUserId !== userId) return null;
    const [club, user] = await Promise.all([
      db.venueOrg.findUnique({
        where: { id: e.tenantId },
        select: { stripeAccountId: true, payoutsEnabled: true },
      }),
      db.user.findUnique({ where: { id: userId }, select: { email: true, locale: true } }),
    ]);
    return { e, club, user };
  });
  if (!found) {
    throw new TournamentPaymentError('TOURNAMENT_PAYMENT_NOT_DUE', 404, 'Entry not found.');
  }
  const { e, club, user } = found;
  const fee = onlineFee(e.tournament);
  if (
    !fee ||
    e.status !== 'PENDING' ||
    !awaitingPayment(e) ||
    e.tournament.status !== 'REGISTRATION'
  ) {
    throw new TournamentPaymentError(
      'TOURNAMENT_PAYMENT_NOT_DUE',
      409,
      'This entry has nothing to pay.',
    );
  }
  if (!club?.stripeAccountId || !club.payoutsEnabled) {
    throw new TournamentPaymentError(
      'TOURNAMENT_ONLINE_FEE_UNAVAILABLE',
      409,
      'The club cannot take payments online right now.',
    );
  }

  const dueBy = new Date(now.getTime() + PAYMENT_WINDOW_MS);
  const back = absoluteUrl(`/tournaments/${encodeURIComponent(e.tournament.id)}`);
  const session = await createEntryCheckoutSession({
    entryId: e.id,
    tournamentName: e.tournament.name,
    amountCents: fee,
    currency: TOURNAMENT_CURRENCY,
    stripeAccountId: club.stripeAccountId,
    successUrl: `${back}?paid=1`,
    cancelUrl: `${back}?paid=0`,
    expiresAt: dueBy,
    customerEmail: user?.email ?? null,
    locale: user?.locale === 'en' ? 'en' : 'bg',
    idempotencyKey: `entry-checkout:${e.id}:${dueBy.getTime()}`,
  });
  if (!session.url) throw new Error('Stripe answered a checkout session without a URL');

  // The newest page is the entry's: the webhook finds the entry by it.
  await runAsSuperuser((db) =>
    db.tournamentEntry.updateMany({
      where: { id: e.id, tenantId: e.tenantId, paidAt: null },
      data: { stripeCheckoutSessionId: session.id, paymentDueBy: dueBy },
    }),
  );
  return { checkoutUrl: session.url, dueBy };
}

// ─── The webhook ───────────────────────────────────────────────────────

export interface EntryPaymentResult {
  handled: boolean;
  entryId?: string;
  /** Paid while still waiting for the club: tell the club and the partner. */
  received?: boolean;
  /** Paid after the entry lapsed or the tournament ended: refund it. */
  refundDue?: boolean;
}

/**
 * `checkout.session.completed` for an entry fee: the payment recorded, the
 * cut on the statement. Runs inside the webhook's transaction, as
 * app_superuser.
 *
 * The entry is found by the session id on OUR row, as a booking is found by
 * its payment intent: metadata is only a cross-check. A page the player left
 * for a newer one still records here when it is the entry's newest unpaid
 * one; a second payment for an entry already paid is refused, audited, and
 * left for a person to refund.
 */
export async function handleEntryCheckoutCompleted(
  db: PrismaClient,
  session: Stripe.Checkout.Session,
  now: Date = new Date(),
): Promise<EntryPaymentResult> {
  const entryId = session.metadata?.tournamentEntryId;
  if (session.mode !== 'payment' || !entryId) return { handled: false };

  // guardrail-allow: cross-tenant — a webhook has no club; the entry is found by
  // the session id on our own row (or the id it carries), then every write states its tenantId.
  const e = await db.tournamentEntry.findFirst({
    where: { OR: [{ stripeCheckoutSessionId: session.id }, { id: entryId }] },
    select: {
      id: true,
      tenantId: true,
      status: true,
      paidAt: true,
      stripeCheckoutSessionId: true,
      tournament: {
        select: { id: true, name: true, status: true },
      },
    },
  });
  if (!e || e.id !== entryId) {
    logger.warn('tournament checkout completed for no entry', {
      component: 'tournament-payments',
      sessionId: session.id,
    });
    return { handled: false };
  }
  const paymentIntent =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  const amount = session.amount_total ?? 0;
  if (session.payment_status !== 'paid' || !paymentIntent || amount <= 0) {
    return { handled: true, entryId: e.id };
  }
  if (e.paidAt) {
    // Already paid, by another page: this money is not the entry's.
    await appendAuditEntry(db, {
      tenantId: e.tenantId,
      actorUserId: null,
      actorType: 'SYSTEM',
      entity: 'TournamentEntry',
      entityId: e.id,
      action: AUDIT_ACTIONS.PAYMENT_UNAPPLIED,
      details: `A second entry fee was paid (${paymentIntent}); refund it by hand.`,
      detailsJson: { category: 'billing', paymentIntent, sessionId: session.id, amount },
    });
    return { handled: true, entryId: e.id };
  }

  // Paid after the entry lapsed, or after the club or the tournament moved on:
  // no place is held, so the fee goes back.
  const late = e.status !== 'PENDING' || e.tournament.status !== 'REGISTRATION';
  await db.tournamentEntry.updateMany({
    where: { id: e.id, tenantId: e.tenantId, paidAt: null },
    data: {
      paidAt: now,
      paidCents: amount,
      stripePaymentIntentId: paymentIntent,
      stripeCheckoutSessionId: session.id,
      paymentDueBy: null,
      ...(late ? { refundDueAt: now } : {}),
    },
  });
  await writeFeeCharge(db, {
    tenantId: e.tenantId,
    entryId: e.id,
    paymentIntentId: paymentIntent,
    tournamentId: e.tournament.id,
    tournamentName: e.tournament.name,
    paidCents: amount,
    currency: (session.currency ?? TOURNAMENT_CURRENCY).toUpperCase(),
    now,
  });
  await appendAuditEntry(db, {
    tenantId: e.tenantId,
    actorUserId: null,
    actorType: 'SYSTEM',
    entity: 'TournamentEntry',
    entityId: e.id,
    action: AUDIT_ACTIONS.TOURNAMENT_FEE_PAID,
    details: late ? 'Entry fee paid after the entry lapsed; refund due' : 'Entry fee paid online',
    detailsJson: { category: 'billing', paymentIntent, amount, late },
  });
  return { handled: true, entryId: e.id, received: !late, refundDue: late };
}

/**
 * `checkout.session.expired`: the page closed unpaid. The entry lapses if
 * that page was its newest; an older page closing changes nothing.
 */
export async function handleEntryCheckoutExpired(
  db: PrismaClient,
  session: Stripe.Checkout.Session,
  now: Date = new Date(),
): Promise<EntryPaymentResult> {
  if (session.mode !== 'payment' || !session.metadata?.tournamentEntryId) return { handled: false };
  // guardrail-allow: cross-tenant — a webhook has no club; the session id on
  // our own row names the one entry.
  const lapsed = await db.tournamentEntry.updateMany({
    where: { stripeCheckoutSessionId: session.id, paidAt: null, status: 'PENDING' },
    data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnByUserId: null },
  });
  return { handled: lapsed.count > 0 };
}

/** The cut, as a CHARGE line on the club's statement: the club's rate now. */
async function writeFeeCharge(
  db: PrismaClient,
  input: {
    tenantId: string;
    entryId: string;
    paymentIntentId: string;
    tournamentId: string;
    tournamentName: string;
    paidCents: number;
    currency: string;
    now: Date;
  },
): Promise<void> {
  const club = await db.venueOrg.findUnique({
    where: { id: input.tenantId },
    select: { tournamentFeePercent: true },
  });
  const bps = percentToBps(club?.tournamentFeePercent.toString() ?? '0') ?? 0;
  await db.tournamentFeeLine.createMany({
    data: [
      {
        tenantId: input.tenantId,
        entryId: input.entryId,
        paymentIntentId: input.paymentIntentId,
        kind: 'CHARGE',
        tournamentId: input.tournamentId,
        tournamentName: input.tournamentName,
        statementMonth: statementMonthOf(input.now),
        priceCents: input.paidCents,
        feeBps: bps,
        feeCents: feeCentsFor(input.paidCents, bps),
        currency: input.currency,
      },
    ],
    skipDuplicates: true,
  });
}

// ─── Refunds ───────────────────────────────────────────────────────────

/**
 * Owe the fee back on these entries (64, 65): only on the ones paid and not
 * already owed. Inside the caller's transaction, so the refund is owed
 * exactly when the decline, the cancellation or the withdrawal commits.
 */
export async function markRefundDue(
  db: PrismaClient,
  tenantId: string,
  entryIds: string[],
  now: Date,
): Promise<number> {
  if (entryIds.length === 0) return 0;
  const r = await db.tournamentEntry.updateMany({
    where: { tenantId, id: { in: entryIds }, paidAt: { not: null }, refundDueAt: null },
    data: { refundDueAt: now },
  });
  return r.count;
}

/**
 * Make the refunds owed: Stripe first, then the entry and a REVERSAL line.
 * After a commit, by whoever owed one, and by the sweep for anything a
 * failure left. Never throws: a refund that fails stays owed.
 */
export async function processDueRefunds(
  opts: { entryIds?: string[]; now?: Date } = {},
): Promise<{ refunded: number; failed: number }> {
  const now = opts.now ?? new Date();
  // guardrail-allow: cross-tenant — the refunds owed at every club; each write
  // states the entry's own tenantId.
  const due = await runAsSuperuser((db) =>
    db.tournamentEntry.findMany({
      where: {
        refundDueAt: { not: null },
        refundedAt: null,
        paidAt: { not: null },
        stripePaymentIntentId: { not: null },
        ...(opts.entryIds ? { id: { in: opts.entryIds } } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        paidCents: true,
        stripePaymentIntentId: true,
        tournament: { select: { id: true, name: true } },
      },
      orderBy: { refundDueAt: 'asc' },
      take: SWEEP_LIMIT,
    }),
  );
  // The charges the refunds reverse, read once rather than per entry.
  // guardrail-allow: cross-tenant — the lines of the payments above, each by its own id.
  const charges = due.length
    ? await runAsSuperuser((db) =>
        db.tournamentFeeLine.findMany({
          where: {
            kind: 'CHARGE',
            paymentIntentId: { in: due.map((e) => e.stripePaymentIntentId!) },
          },
          select: { paymentIntentId: true, feeBps: true, feeCents: true, currency: true },
          take: due.length,
        }),
      )
    : [];
  const chargeOf = new Map(charges.map((c) => [c.paymentIntentId, c]));
  let refunded = 0;
  let failed = 0;
  for (const e of due) {
    try {
      const refund = await refundEntryFee({
        paymentIntentId: e.stripePaymentIntentId!,
        amountCents: e.paidCents!,
        entryId: e.id,
        idempotencyKey: `entry-refund:${e.id}`,
      });
      // guardrail-allow: cross-tenant — the entry just refunded, by its own tenantId.
      await runAsSuperuser(async (db) => {
        const done = await db.tournamentEntry.updateMany({
          where: { id: e.id, tenantId: e.tenantId, refundedAt: null },
          data: { refundedAt: now, refundedCents: e.paidCents, stripeRefundId: refund.id },
        });
        if (done.count === 0) return;
        const charge = chargeOf.get(e.stripePaymentIntentId!);
        if (charge) {
          await db.tournamentFeeLine.createMany({
            data: [
              {
                tenantId: e.tenantId,
                entryId: e.id,
                paymentIntentId: e.stripePaymentIntentId!,
                kind: 'REVERSAL',
                tournamentId: e.tournament.id,
                tournamentName: e.tournament.name,
                statementMonth: statementMonthOf(now),
                priceCents: -e.paidCents!,
                feeBps: charge.feeBps,
                feeCents: -charge.feeCents,
                currency: charge.currency,
              },
            ],
            skipDuplicates: true,
          });
        }
        await appendAuditEntry(db, {
          tenantId: e.tenantId,
          actorUserId: null,
          actorType: 'SYSTEM',
          entity: 'TournamentEntry',
          entityId: e.id,
          action: AUDIT_ACTIONS.TOURNAMENT_FEE_REFUNDED,
          details: 'Entry fee refunded',
          detailsJson: { category: 'billing', refundId: refund.id, amount: e.paidCents },
        });
      });
      refunded++;
    } catch (err) {
      failed++;
      logger.warn('tournament entry refund failed; it stays owed', {
        component: 'tournament-payments',
        entryId: e.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { refunded, failed };
}

/**
 * The sweep (cron): unpaid entries past their deadline lapse, and the
 * refunds still owed are made.
 */
export async function sweepTournamentPayments(now: Date = new Date()) {
  // guardrail-allow: cross-tenant — a sweep across every club; each row keeps its tenantId.
  const lapsed = await runAsSuperuser((db) =>
    db.tournamentEntry.updateMany({
      where: {
        status: 'PENDING',
        paidAt: null,
        paymentDueBy: { lt: new Date(now.getTime() - LAPSE_GRACE_MS) },
      },
      data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnByUserId: null },
    }),
  );
  const refunds = await processDueRefunds({ now });
  return { lapsed: lapsed.count, ...refunds };
}
