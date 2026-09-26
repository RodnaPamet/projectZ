import type { PrismaClient } from '@prisma/client';

import { appendEntry } from '@/app-layer/usecases/wallet';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * What staff may change about a player's standing at their club.
 *
 * ═══ WHAT IS NOT HERE, AND WHY ═══
 *
 * Nothing touches `User` or `PlayerProfile`. Those are global: one person
 * across every club they play at, with no tenantId and no row security. A club
 * editing a player's name would be editing it everywhere, including at clubs
 * they have never visited.
 *
 * So this file only writes `PlayerVenueRelationship` — the standing AT this
 * club — and the credit ledger, which is tenant-scoped.
 */

export class PlayerNotAtThisClubError extends Error {
  constructor() {
    super(
      'That player has no relationship with this club. Players are global; their standing ' +
        'at a club is not, and this can only change the latter.',
    );
    this.name = 'PlayerNotAtThisClubError';
  }
}

export class CreditAdjustmentTooLargeError extends Error {
  constructor(limit: number) {
    super(
      `A single manual adjustment is capped at ${limit / 100} EUR. A larger correction is ` +
        'either a mistake or something that wants more than one person looking at it.',
    );
    this.name = 'CreditAdjustmentTooLargeError';
  }
}

/**
 * The ceiling on one hand-typed adjustment.
 *
 * Not a permission boundary — someone holding `players.credit_adjust` can make
 * two. It exists because the field takes euros and a slipped decimal point
 * turns 5.00 into 500.00, and the ledger is append-only: the correction is
 * another row, and the wrong number stays visible for ever.
 */
export const MAX_CREDIT_ADJUSTMENT_CENTS = 50_000;

/**
 * ═══ THE ID IS CHECKED BEFORE IT REACHES PRISMA ═══
 *
 * Prisma reads `undefined` in a `where` as NOT SPECIFIED, not as "matches
 * nothing". So a non-string `playerUserId` — which a crafted POST to a Server
 * Action can supply, since the argument is not a form field — collapsed
 * `where: { tenantId, playerUserId }` to `where: { tenantId }`.
 *
 * `findFirst` then returned an arbitrary player at the club instead of
 * refusing, and the `updateMany` below rewrote EVERY player's tags in one
 * request. Tags drive `PricingConditions.playerTags`, so that is a silent
 * pricing change for the whole club as well as data loss.
 */
function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new PlayerNotAtThisClubError();
}

async function ownPlayer(db: PrismaClient, tenantId: string, playerUserId: string) {
  assertId(playerUserId);

  const rel = await db.playerVenueRelationship.findFirst({
    where: { tenantId, playerUserId },
    select: { id: true, tags: true },
  });
  if (!rel) throw new PlayerNotAtThisClubError();
  return rel;
}

export async function setPlayerTags(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  playerUserId: string,
  tags: readonly string[],
) {
  const before = await ownPlayer(db, tenantId, playerUserId);

  // Deduplicated and trimmed here rather than trusted from the form: tags drive
  // `PricingConditions.playerTags`, so " coach" and "coach" would be two
  // different rules' worth of behaviour for what a human typed as one tag.
  const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();

  // By the row's own id, not by a filter. `ownPlayer` has already proved this
  // row is at this club, and a unique-key update cannot touch a second row
  // however the arguments arrive. `updateMany` on a filter was what turned a
  // bad id into a club-wide overwrite.
  await db.playerVenueRelationship.update({
    where: { id: before.id },
    data: { tags: cleaned },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'PlayerVenueRelationship',
    entityId: before.id,
    action: AUDIT_ACTIONS.PLAYER_TAGS_CHANGED,
    details: `Tags for player ${playerUserId} set to [${cleaned.join(', ')}]`,
    detailsJson: {
      category: 'access',
      summary: 'Player tags changed',
      before: { tags: before.tags },
      after: { tags: cleaned },
    },
  });

  return cleaned;
}

/**
 * Move a player's credit by hand.
 *
 * ═══ THE CALLER MUST OPEN A SERIALIZABLE TRANSACTION ═══
 *
 * `appendEntry` reads the running balance and writes the next one. Under READ
 * COMMITTED two concurrent appends read the same balance and write the same
 * `balanceAfterCents`, and the ledger stops agreeing with itself without
 * raising — so it verifies the isolation it actually GOT and throws
 * `LedgerIsolationError` otherwise.
 *
 * Isolation can only be set on the outermost BEGIN. `runInTenantContext` opens
 * a transaction, so the caller has to ask for it there:
 *
 *   runInTenantContext(tenantId, fn, undefined, { isolationLevel: 'Serializable' })
 *
 * Requesting it inside would be silently dropped to a SAVEPOINT. The sweeper
 * documents the same trap, and checks for it on the first booking of every run
 * rather than on the first player who happens to have a balance.
 */
export async function adjustPlayerCredit(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  input: { playerUserId: string; deltaCents: number; note: string },
) {
  const rel = await ownPlayer(db, tenantId, input.playerUserId);

  if (Math.abs(input.deltaCents) > MAX_CREDIT_ADJUSTMENT_CENTS) {
    throw new CreditAdjustmentTooLargeError(MAX_CREDIT_ADJUSTMENT_CENTS);
  }

  const entry = await appendEntry(db, {
    tenantId,
    userId: input.playerUserId,
    deltaCents: input.deltaCents,
    reason: 'ADMIN_ADJUST',
    refType: 'AdminAdjustment',
    refId: actorUserId,
  });

  // The ledger row records the money. This records the DECISION — who, and the
  // reason they typed. `CreditLedgerEntry` has nowhere to put either: its
  // `refId` holds the actor, which is not the same as an explanation.
  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'PlayerVenueRelationship',
    entityId: rel.id,
    action: AUDIT_ACTIONS.PLAYER_CREDIT_ADJUSTED,
    details: input.note,
    detailsJson: {
      category: 'billing',
      summary: 'Player credit adjusted',
      after: {
        playerUserId: input.playerUserId,
        deltaCents: input.deltaCents,
        balanceAfterCents: entry.balanceAfterCents,
        ledgerEntryId: entry.id,
        note: input.note,
      },
    },
  });

  return entry;
}
