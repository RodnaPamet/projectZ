import type { PrismaClient } from '@prisma/client';

/**
 * The club's players.
 *
 * ═══ THIS JOIN CROSSES THE RLS BOUNDARY, ON PURPOSE ═══
 *
 * `player_venue_relationship` is tenant-scoped with FORCE row security.
 * `app_user` and `player_profile` are GLOBAL and deliberately carry no policy
 * at all — a person is one person across every club they play at, and
 * `rls-coverage` allowlists exactly those two tables.
 *
 * So the query is two steps, in this order, and the order is the safety:
 *
 *   1. read the relationships, which RLS constrains to this club
 *   2. read the users those rows name, by id
 *
 * Starting from the users instead would be a scan of every person on the
 * platform, filtered in application code — one forgotten `where` from being a
 * cross-club directory. Starting from the relationships means the set of ids is
 * already the answer, and step 2 cannot widen it.
 *
 * There is also no Prisma relation to follow: `playerUserId` is a bare column
 * with no `@relation`, precisely because the two live on different sides of the
 * tenancy boundary. The join being manual is the model telling the truth.
 */

export const PLAYER_LIST_LIMIT = 500;

export interface PlayerListItem {
  playerUserId: string;
  name: string | null;
  email: string;
  tags: string[];
  noShowCount: number;
  lastPlayedAt: Date | null;
  membershipLevel: string | null;
  creditCents: number;
}

export async function listPlayers(
  db: PrismaClient,
  tenantId: string,
  opts: { search?: string } = {},
): Promise<PlayerListItem[]> {
  const relationships = await db.playerVenueRelationship.findMany({
    where: { tenantId },
    select: {
      playerUserId: true,
      tags: true,
      noShowCount: true,
      lastPlayedAt: true,
    },
    // Recently active first — the people a club is actually dealing with.
    // `playerUserId` breaks ties because `lastPlayedAt` is nullable and a
    // club's first import gives everyone the same null.
    orderBy: [{ lastPlayedAt: 'desc' }, { playerUserId: 'asc' }],
    take: PLAYER_LIST_LIMIT,
  });

  if (relationships.length === 0) return [];

  const ids = relationships.map((r) => r.playerUserId);

  // Three lookups against a bounded id set, rather than one per player.
  const [users, memberships, credit] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
      // Bounded by the id set, and bounded again explicitly: `query-shape`'s
      // D2 rule takes no view on whether an `in` happens to be small today.
      take: PLAYER_LIST_LIMIT,
    }),
    db.membership.findMany({
      where: { tenantId, playerUserId: { in: ids }, status: 'ACTIVE' },
      select: { playerUserId: true, level: true },
      // A player may hold several levels at once — `@@unique([tenantId,
      // playerUserId, level])` permits it — so this can exceed the id count,
      // and the order decides which one the list shows. Alphabetical is
      // arbitrary but stable; without it the row flickers between renders.
      orderBy: [{ playerUserId: 'asc' }, { level: 'asc' }],
      take: PLAYER_LIST_LIMIT * 4,
    }),
    /**
     * Balance as the SUM OF DELTAS, not the latest `balanceAfterCents`.
     *
     * The ledger is append-only and every row carries a running total, so the
     * two must agree — `wallet.getBalance` reads the running total because it
     * needs one player's balance and an index makes that a single row.
     *
     * For a list, the sum is one grouped query instead of one query per
     * player, and it is the definition rather than a cached copy of it: if the
     * two ever disagreed, the sum is the one that is right. An integration
     * test asserts they agree, so a disagreement is a failing build rather
     * than two screens quietly showing different numbers.
     */
    db.creditLedgerEntry.groupBy({
      by: ['userId'],
      where: { tenantId, userId: { in: ids } },
      _sum: { deltaCents: true },
    }),
  ]);

  const byId = new Map(users.map((u) => [u.id, u]));
  // First level wins, per the ordering above — a Map built from a list keeps
  // the LAST write, so this is built explicitly rather than by `new Map(...)`.
  const levelById = new Map<string, string>();
  for (const m of memberships)
    if (!levelById.has(m.playerUserId)) levelById.set(m.playerUserId, m.level);
  const creditById = new Map(credit.map((c) => [c.userId, c._sum.deltaCents ?? 0]));

  const rows = relationships.map((r): PlayerListItem => {
    const u = byId.get(r.playerUserId);
    return {
      playerUserId: r.playerUserId,
      name: u?.name ?? null,
      // A relationship whose user row is gone should not crash the screen.
      // It should not happen — nothing deletes users — and if it does, the
      // club needs to see the row rather than a blank page.
      email: u?.email ?? '',
      tags: r.tags,
      noShowCount: r.noShowCount,
      lastPlayedAt: r.lastPlayedAt,
      membershipLevel: levelById.get(r.playerUserId) ?? null,
      creditCents: creditById.get(r.playerUserId) ?? 0,
    };
  });

  const search = opts.search?.trim().toLowerCase();
  if (!search) return rows;

  // Filtered here rather than in SQL: the name lives on the global `app_user`
  // table and the set is already bounded to this club's players by step 1.
  // Pushing it into the database would mean searching users first, which is
  // the direction this file exists to avoid.
  return rows.filter(
    (p) => p.email.toLowerCase().includes(search) || (p.name ?? '').toLowerCase().includes(search),
  );
}

export function playersWereTruncated(rows: readonly unknown[]): boolean {
  return rows.length >= PLAYER_LIST_LIMIT;
}
