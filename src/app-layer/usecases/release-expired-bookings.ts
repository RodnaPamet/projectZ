import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { isSerializationFailure } from '@/lib/db/pg-errors';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { appendEntry } from './wallet';

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
 * Cancellation row, which is a receipt for a CANCELLATION the player asked
 * for, settled against a policy. Nobody asked for this one and no policy
 * applies — the hold simply lapsed.
 *
 * ═══ BUT THERE CAN BE MONEY TO RETURN ═══
 *
 * This comment used to say "there is nothing to refund". That was wrong, and
 * it cost players real credit.
 *
 * `checkoutBooking` spends the wallet BEFORE charging the card, on purpose:
 * "the worst case is credit is debited and the card charge fails, and we
 * refund the credit — a compensating LEDGER ENTRY". Whenever cardDueCents > 0
 * the booking STAYS PENDING with the credit already gone. A player who then
 * closes the tab had their wallet debited for a court they never got, and the
 * sweep — which is the only thing that ever looks at that booking again —
 * used to cancel it and write nothing.
 *
 * So the sweep appends the compensating entry that checkout's own comment
 * promises. Not a Cancellation row: no card was charged, nothing was
 * forfeited, and there is no policy to quote. Just the credit, back.
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

/**
 * The sweep asked for SERIALIZABLE and did not get it.
 *
 * Means it was handed an already-open transaction. Prisma treats the inner
 * `$transaction` as NESTED, issues SAVEPOINT instead of BEGIN, and silently
 * discards the isolation level — it can only be set on the outermost BEGIN.
 */
export class SweepIsolationError extends Error {
  constructor(actual: string) {
    super(
      `releaseExpiredBookings requires SERIALIZABLE and is running at "${actual}".\n\n` +
        `It was handed a transaction handle rather than a top-level client, so its ` +
        `own $transaction became a SAVEPOINT and the isolation request was dropped.\n\n` +
        `Fix the CALLER: pass the top-level client. The sweep opens its own ` +
        `superuser transaction per booking precisely so it can ask for the ` +
        `isolation the credit ledger needs —\n` +
        `  await releaseExpiredBookings(prisma)\n` +
        `not\n` +
        `  await runAsSuperuser((db) => releaseExpiredBookings(db))`,
    );
    this.name = 'SweepIsolationError';
  }
}

/** One run's ceiling. A sweep is not a migration; it comes back in a minute. */
const MAX_PER_RUN = 500;

export interface ReleaseResult {
  scanned: number;
  released: number;
  /** Wallet credit handed back, in cents. Nonzero means someone had paid. */
  creditRefundedCents: number;
  /** True when the cap was hit, so the caller knows more remain. */
  truncated: boolean;
}

/**
 * Why this takes a TOP-LEVEL client and opens its own transactions.
 *
 * The ledger reversal below goes through `appendEntry`, which refuses to run
 * outside SERIALIZABLE — under READ COMMITTED two concurrent appends both read
 * the same balance and both write the same `balanceAfterCents`, and the ledger
 * stops agreeing with itself without raising.
 *
 * Isolation can only be set on the outermost BEGIN. So the sweep cannot be
 * handed an already-open transaction; it has to open its own. One PER BOOKING,
 * not one for the batch: a serializable transaction spanning 500 bookings
 * would contend with every checkout on the platform, and a single 40001 would
 * discard the whole run's work. Per booking, an abort costs exactly one
 * booking, which the next sweep picks up.
 */
export async function releaseExpiredBookings(
  client: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReleaseResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? MAX_PER_RUN, MAX_PER_RUN);

  // guardrail-allow: cross-tenant — a sweep runs for the whole platform; it
  // has no session and no slug to bind to. Every write below re-states the
  // booking's own tenantId.
  const expired = await runAsSuperuser(
    (db) =>
      db.booking.findMany({
        where: {
          status: 'PENDING',
          expiresAt: { not: null, lt: now },
        },
        select: { id: true, tenantId: true, resourceId: true, startTs: true, expiresAt: true },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      }),
    client,
  );

  let released = 0;
  let creditRefundedCents = 0;

  for (const booking of expired) {
    const refunded = await releaseOne(async (db) => {
      // Re-checked inside the write rather than trusted from the read above.
      // A payment could have confirmed this booking in the milliseconds
      // since, and cancelling a paid booking is far worse than missing one
      // this round.
      const updated = await db.booking.updateMany({
        where: { id: booking.id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });

      // Somebody else got there first. Nothing to release, and — critically
      // — nothing to refund: whoever moved it owns its money now.
      if (updated.count === 0) return null;

      const returnedCents = await refundSpentCredit(db, booking);

      await appendAuditEntry(db, {
        tenantId: booking.tenantId,
        actorUserId: null,
        // Nobody cancelled this. A timer did.
        actorType: 'SYSTEM',
        entity: 'Booking',
        entityId: booking.id,
        action: AUDIT_ACTIONS.BOOKING_EXPIRED,
        details:
          returnedCents > 0
            ? `Held slot released: checkout not completed within the window. ` +
              `${returnedCents}¢ of wallet credit returned.`
            : `Held slot released: checkout not completed within the window`,
        detailsJson: {
          category: 'booking',
          summary: 'PENDING booking expired and its slot was released',
          before: { status: 'PENDING' },
          after: { status: 'CANCELLED' },
          expiresAt: booking.expiresAt?.toISOString() ?? null,
          creditRefundedCents: returnedCents,
          source: 'release_expired_bookings',
        },
      });

      return returnedCents;
    }, client);

    if (refunded === null) continue;

    released += 1;
    creditRefundedCents += refunded;
  }

  return {
    scanned: expired.length,
    released,
    creditRefundedCents,
    truncated: expired.length === limit,
  };
}

/**
 * One booking's release, in its own SERIALIZABLE transaction.
 *
 * Returns null when there is nothing to do — either somebody else moved the
 * booking first, or the transaction lost a serialization race.
 *
 * That second case is the price of running at SERIALIZABLE, and it must not
 * take the sweep down with it. A 40001 here means another transaction touched
 * this booking or this wallet concurrently; the row is untouched, nothing was
 * refunded, and the next sweep — a minute later — picks it up. Letting it
 * propagate would abandon every booking after it in the batch because one
 * player happened to be paying at the wrong moment.
 *
 * Only 40001 is swallowed. Anything else is a real failure and still throws.
 */
async function releaseOne(
  fn: (db: PrismaClient) => Promise<number | null>,
  client: PrismaClient,
): Promise<number | null> {
  try {
    return await runAsSuperuser(
      async (db) => {
        // Verify the isolation we actually GOT, before doing any work.
        //
        // `appendEntry` makes this same check, and its message is the one
        // worth reading — but it only runs when there is credit to return. So
        // a sweep handed an open transaction works perfectly until the first
        // player with a wallet balance abandons a checkout, and then fails on
        // the one path where money is at stake. Checking here makes it fail on
        // the first booking of the first run instead, which is the difference
        // between a caught mistake and a production incident.
        const [level] = await db.$queryRawUnsafe<{ iso: string }[]>(
          `SELECT current_setting('transaction_isolation') AS iso`,
        );
        if (level?.iso !== 'serializable') {
          throw new SweepIsolationError(level?.iso ?? 'unknown');
        }

        return fn(db);
      },
      client,
      // The ledger append inside refuses to run at anything weaker, and only
      // the outermost BEGIN can ask for it.
      { isolationLevel: 'Serializable' },
    );
  } catch (err) {
    if (isSerializationFailure(err)) return null;
    throw err;
  }
}

/**
 * Return whatever the wallet paid towards a booking that never happened.
 *
 * Summed from the ledger rather than recomputed, because the ledger is the
 * only thing that knows what was actually taken — `booking.totalCents` is what
 * was OWED, and the wallet may have covered any part of it.
 *
 * Idempotent by construction rather than by a guard: the only caller reaches
 * this line having just flipped the booking PENDING → CANCELLED in the same
 * transaction, and that transition happens exactly once. A second sweep sees
 * `updated.count === 0` and returns before getting here.
 */
async function refundSpentCredit(
  db: PrismaClient,
  booking: { id: string; tenantId: string },
): Promise<number> {
  const spends = await db.creditLedgerEntry.groupBy({
    by: ['userId'],
    where: {
      tenantId: booking.tenantId,
      refType: 'booking',
      refId: booking.id,
      reason: 'SPEND',
    },
    _sum: { deltaCents: true },
  });

  let total = 0;

  // Grouped by user, because a split booking can have several wallets in it.
  // Each one gets its own entry — a ledger is per person, and a lump sum
  // returned to the booker would be a second, quieter way to lose money.
  for (const spend of spends) {
    const spentCents = Math.abs(spend._sum.deltaCents ?? 0);
    if (spentCents === 0) continue;

    await appendEntry(db, {
      tenantId: booking.tenantId,
      userId: spend.userId,
      deltaCents: spentCents,
      reason: 'REFUND_CREDIT',
      refType: 'booking',
      refId: booking.id,
    });

    total += spentCents;
  }

  return total;
}
