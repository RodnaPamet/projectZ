import type { PrismaClient } from '@prisma/client';

/**
 * The club's players.
 *
 * ═══ WHO COUNTS AS A PLAYER HERE (#348) ═══
 *
 * Anybody the club has a record of playing with, from three tenant-scoped
 * sources, merged:
 *
 *   tenant_membership           an ACTIVE PLAYER membership — booking makes one (#229)
 *   booking                     a booking at this club under their account
 *   player_venue_relationship   the club's own notes: tags, the no-show count
 *
 * This read only the relationship once, and the only writer of that table is
 * `markNoShow`. So a player appeared here only after the club had marked them
 * a no-show, and the screen's empty state ("players appear after their first
 * booking") was false for every club. The relationship is now the club's notes
 * about a player, left-joined for its counters, and `ownPlayer` in
 * `usecases/players.ts` creates it the first time the club writes one.
 *
 * ═══ THIS JOIN CROSSES THE RLS BOUNDARY, ON PURPOSE ═══
 *
 * All three sources are tenant-scoped with FORCE row security. `app_user` and
 * `player_profile` are GLOBAL and deliberately carry no policy at all — a
 * person is one person across every club they play at, and `rls-coverage`
 * allowlists exactly those two tables.
 *
 * So the query is two steps, in this order, and the order is the safety:
 *
 *   1. read the club's rows, which RLS constrains to this club
 *   2. read the users those rows name, by id
 *
 * Starting from the users instead would be a scan of every person on the
 * platform, filtered in application code — one forgotten `where` from being a
 * cross-club directory. Starting from the club's rows means the set of ids is
 * already the answer, and step 2 cannot widen it.
 *
 * There is also no Prisma relation to follow: `playerUserId` and
 * `bookedByUserId` are bare columns with no `@relation` to the user, precisely
 * because the two live on different sides of the tenancy boundary. The join
 * being manual is the model telling the truth.
 */

export const PLAYER_LIST_LIMIT = 500;

export interface PlayerListItem {
  playerUserId: string;
  name: string | null;
  email: string;
  /**
   * The player deleted their account (#370). They stay on the list, because
   * their bookings stay in the club's records, under no name and no address:
   * the screen says "Изтрит потребител" and offers nothing to change.
   */
  deleted: boolean;
  tags: string[];
  noShowCount: number;
  /** When staff last lifted this player's no-show block here (#354). */
  noShowBlockClearedAt: Date | null;
  lastPlayedAt: Date | null;
  membershipLevel: string | null;
  creditCents: number;
}

/** A booking that was played, or is being: what "last played" is measured from. */
const PLAYED = ['CONFIRMED', 'COMPLETED'] as const;

export async function listPlayers(
  db: PrismaClient,
  tenantId: string,
  opts: { search?: string; now?: Date } = {},
): Promise<PlayerListItem[]> {
  const now = opts.now ?? new Date();

  // Step 1: the club's own rows, each bounded. Grouped reads, not one per
  // player: `query-shape` refuses a read in a loop, and rightly.
  const [relationships, playerMemberships, booked, played] = await Promise.all([
    db.playerVenueRelationship.findMany({
      where: { tenantId },
      select: {
        playerUserId: true,
        tags: true,
        noShowCount: true,
        noShowBlockClearedAt: true,
        lastPlayedAt: true,
      },
      orderBy: [{ lastPlayedAt: 'desc' }, { playerUserId: 'asc' }],
      take: PLAYER_LIST_LIMIT,
    }),
    db.tenantMembership.findMany({
      where: { tenantId, role: 'PLAYER', status: 'ACTIVE' },
      select: { userId: true },
      orderBy: [{ createdAt: 'desc' }, { userId: 'asc' }],
      take: PLAYER_LIST_LIMIT,
    }),
    // Everybody who has booked here under their account, whatever became of
    // the booking: a player who booked and cancelled is still the club's
    // player. A guest booking has no account and no row here.
    db.booking.groupBy({
      by: ['bookedByUserId'],
      where: { tenantId, bookedByUserId: { not: null } },
      _max: { startTs: true },
      orderBy: { _max: { startTs: 'desc' } },
      take: PLAYER_LIST_LIMIT,
    }),
    // And when each last played: the latest booking that has started and was
    // not cancelled, pending or a no-show.
    db.booking.groupBy({
      by: ['bookedByUserId'],
      where: {
        tenantId,
        bookedByUserId: { not: null },
        status: { in: [...PLAYED] },
        startTs: { lte: now },
      },
      _max: { startTs: true },
      orderBy: { _max: { startTs: 'desc' } },
      take: PLAYER_LIST_LIMIT,
    }),
  ]);

  const relById = new Map(relationships.map((r) => [r.playerUserId, r]));
  const playedById = new Map<string, Date>();
  for (const p of played) {
    if (p.bookedByUserId && p._max.startTs) playedById.set(p.bookedByUserId, p._max.startTs);
  }

  const lastPlayed = (id: string): Date | null => {
    const fromBookings = playedById.get(id) ?? null;
    const fromNotes = relById.get(id)?.lastPlayedAt ?? null;
    if (!fromBookings) return fromNotes;
    if (!fromNotes) return fromBookings;
    return fromBookings > fromNotes ? fromBookings : fromNotes;
  };

  const candidates = new Set<string>([
    ...relationships.map((r) => r.playerUserId),
    ...playerMemberships.map((m) => m.userId),
    ...booked.flatMap((b) => (b.bookedByUserId ? [b.bookedByUserId] : [])),
  ]);

  // Recently active first — the people a club is actually dealing with. The id
  // breaks ties, because a player who has only booked ahead has no "last
  // played" yet, and neither has a club's first import.
  const ids = [...candidates]
    .map((id) => ({ id, at: lastPlayed(id)?.getTime() ?? -Infinity }))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, PLAYER_LIST_LIMIT)
    .map((c) => c.id);

  if (ids.length === 0) return [];

  // Step 2: three lookups against the bounded id set, rather than one per player.
  const [users, memberships, credit] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true, deletedAt: true },
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

  const rows = ids.map((id): PlayerListItem => {
    const u = byId.get(id);
    const r = relById.get(id);
    const deleted = !!u?.deletedAt;
    return {
      playerUserId: id,
      name: deleted ? null : (u?.name ?? null),
      // A row whose user is gone should not crash the screen: the club needs to
      // see the row rather than a blank page. A deleted account's row keeps no
      // address at all, not even its tombstone's (#370).
      email: deleted ? '' : (u?.email ?? ''),
      deleted,
      // No relationship yet means the club has written nothing about them.
      tags: r?.tags ?? [],
      noShowCount: r?.noShowCount ?? 0,
      noShowBlockClearedAt: r?.noShowBlockClearedAt ?? null,
      lastPlayedAt: lastPlayed(id),
      membershipLevel: levelById.get(id) ?? null,
      creditCents: creditById.get(id) ?? 0,
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
