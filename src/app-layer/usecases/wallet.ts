import { Prisma, type LedgerReason, type PrismaClient } from '@prisma/client';

/**
 * The wallet.
 *
 * A balance is not a number you store and mutate. It is the SUM OF A LEDGER,
 * and the ledger is append-only (enforced by a database trigger, not by
 * convention — see the P16 migration).
 *
 * `balanceAfterCents` is denormalised onto each entry so that reading a
 * balance is one indexed row rather than a SUM over the user's whole history.
 * That denormalisation is only safe if it is written under SERIALIZABLE
 * isolation — see below.
 */

export class InsufficientCreditError extends Error {
  readonly code = 'insufficient_credit';
  constructor(
    readonly balanceCents: number,
    readonly requestedCents: number,
  ) {
    super(`Insufficient credit: balance ${balanceCents}, requested ${requestedCents}.`);
    this.name = 'InsufficientCreditError';
  }
}

export async function getBalance(
  db: PrismaClient,
  input: { tenantId: string; userId: string },
): Promise<number> {
  const latest = await db.creditLedgerEntry.findFirst({
    where: { tenantId: input.tenantId, userId: input.userId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfterCents: true },
  });

  return latest?.balanceAfterCents ?? 0;
}

/**
 * The ledger asked for SERIALIZABLE and did not get it.
 *
 * Thrown rather than proceeding, because proceeding is how money disappears
 * QUIETLY. Measured on the production wiring before this check existed: ten
 * concurrent credits of 100¢ wrote ten rows whose deltas summed to 1000,
 * while the balance those same rows reported was 300. No error. No 40001.
 * Nothing to alert on. The ledger simply disagreed with itself.
 */
export class LedgerIsolationError extends Error {
  constructor(actual: string) {
    super(
      `The credit ledger requires SERIALIZABLE and is running at "${actual}".\n\n` +
        `This almost certainly means appendEntry was handed a transaction handle ` +
        `rather than a top-level client. Prisma treats the inner $transaction as ` +
        `NESTED, issues SAVEPOINT instead of BEGIN, and silently discards the ` +
        `isolationLevel — isolation can only be set on the outermost BEGIN.\n\n` +
        `Fix the CALLER, not this check: pass the isolation level to the wrapper ` +
        `that opens the outer transaction, e.g.\n` +
        `  runInTenantContext(tenantId, fn, client, { isolationLevel: 'Serializable' })\n\n` +
        `Under READ COMMITTED two concurrent credits both read the same balance ` +
        `and both write the same balanceAfterCents. The deltas and the balance ` +
        `stop agreeing, and nothing raises.`,
    );
    this.name = 'LedgerIsolationError';
  }
}

/**
 * Append an entry.
 *
 * ─── Why SERIALIZABLE ────────────────────────────────────────────────
 *
 * The obvious implementation is:
 *
 *     const balance = await getBalance(...);            // reads 500
 *     await insert({ delta: +300, balanceAfter: 800 }); // writes 800
 *
 * Two concurrent credits both read 500. Both write 800. The user is credited
 * €3 twice and their balance says €8 instead of €11 — money vanishes, and the
 * ledger is internally INCONSISTENT: the deltas sum to 1100 while the last
 * `balanceAfterCents` says 800. The append-only trigger cannot save you here,
 * because nothing was updated; two bad rows were appended.
 *
 * READ COMMITTED does not prevent this — the second transaction's read is
 * perfectly legal. SERIALIZABLE detects the write-skew and aborts one of them,
 * and the caller retries.
 *
 * An integration test runs concurrent credits and asserts the final balance
 * equals the sum of the deltas.
 */
export async function appendEntry(
  db: PrismaClient,
  input: {
    tenantId: string;
    userId: string;
    deltaCents: number;
    reason: LedgerReason;
    refType?: string;
    refId?: string;
  },
): Promise<{ id: string; balanceAfterCents: number }> {
  if (!Number.isInteger(input.deltaCents) || input.deltaCents === 0) {
    throw new Error(`deltaCents must be a non-zero integer; got ${input.deltaCents}`);
  }

  const entry = await db.$transaction(
    async (tx) => {
      // Verify the isolation level we actually GOT, before reading anything.
      //
      // Requesting Serializable above is not the same as running at it: if `db`
      // is already an interactive transaction, the request is silently dropped
      // (see LedgerIsolationError). One cheap local lookup — no I/O beyond the
      // round trip — is a small price for a ledger that cannot quietly lie.
      const [level] = await tx.$queryRawUnsafe<{ iso: string }[]>(
        `SELECT current_setting('transaction_isolation') AS iso`,
      );
      if (level?.iso !== 'serializable') {
        throw new LedgerIsolationError(level?.iso ?? 'unknown');
      }

      const latest = await tx.creditLedgerEntry.findFirst({
        where: { tenantId: input.tenantId, userId: input.userId },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfterCents: true },
      });

      const balance = latest?.balanceAfterCents ?? 0;
      const next = balance + input.deltaCents;

      // A negative balance means we let someone spend credit they do not have.
      // Refuse rather than record it — a ledger that can go negative is a
      // ledger that has already lost money.
      if (next < 0) {
        throw new InsufficientCreditError(balance, Math.abs(input.deltaCents));
      }

      return tx.creditLedgerEntry.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          deltaCents: input.deltaCents,
          reason: input.reason,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          balanceAfterCents: next,
        },
      });
    },
    // See the header note. READ COMMITTED loses money under concurrency.
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  return { id: entry.id, balanceAfterCents: entry.balanceAfterCents };
}

/**
 * Spend credit at checkout, applying the wallet BEFORE the card.
 *
 * Returns how much the card still has to cover. If the wallet covers the whole
 * booking, the card is never charged at all.
 */
export async function spendCredit(
  db: PrismaClient,
  input: { tenantId: string; userId: string; amountCents: number; bookingId: string },
): Promise<{ walletAppliedCents: number; cardDueCents: number }> {
  const balance = await getBalance(db, { tenantId: input.tenantId, userId: input.userId });

  // Never spend more than is there, and never more than is owed.
  const applied = Math.min(balance, input.amountCents);

  if (applied > 0) {
    await appendEntry(db, {
      tenantId: input.tenantId,
      userId: input.userId,
      deltaCents: -applied,
      reason: 'SPEND',
      refType: 'booking',
      refId: input.bookingId,
    });
  }

  return {
    walletAppliedCents: applied,
    cardDueCents: input.amountCents - applied,
  };
}
