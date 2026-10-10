import { Prisma, type PrismaClient, type SportType } from '@prisma/client';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarUrlOf } from '@/lib/media/avatar-url';

import { reportContent } from './reviews';

/**
 * Messaging's reads ACROSS people and clubs (#375): who can be found, who can
 * be written to, and the names on a conversation.
 *
 * ═══ WHY BYPASSRLS, AND WHY THAT IS BOUNDED ═══
 *
 * Every question here spans tenants or other people's own rows by its nature:
 *
 *   - "have these two played together?" reads bookings at every club;
 *   - a player's card shows their sports and levels, which RLS keeps to the
 *     player themselves (`player_sport_level_owner_only`);
 *   - a player's inbox names the clubs it talks to, and `venue_org` is keyed
 *     on the club's own tenant binding.
 *
 * So these run as `app_superuser`, and each one is shaped so that it cannot be
 * a directory of anything else: every read is keyed on ids the caller already
 * holds (their own id, the ids on a page RLS already let them see) or is a
 * name search that returns ONLY what the public card shows — name, picture,
 * sports with levels — and never an email, a phone or a booking. Nothing here
 * writes.
 *
 * Kept apart from `messaging.ts`, which never bypasses RLS, so that the one
 * file pinned by `superuser-call-sites` is small enough to review whole.
 */

/** The fewest characters a name search needs: fewer matches half the country. */
export const PLAYER_SEARCH_MIN = 2;
/** The most results a search returns. Not paginated: refine the query instead. */
export const PLAYER_SEARCH_LIMIT = 20;

export interface SportLevelCard {
  sport: SportType;
  level: number;
}

/** What anyone may see of a player (#375): never an email, a phone or a booking. */
export interface PlayerCard {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  sports: SportLevelCard[];
}

export interface PersonName {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  /** The account was deleted (#370): show «Изтрит потребител». */
  deleted: boolean;
}

export interface ClubName {
  tenantId: string;
  slug: string;
  name: string;
}

/** `%`, `_` and `\` are LIKE syntax; a search for "50%" means the characters. */
function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function sportsOf(
  db: PrismaClient,
  userIds: string[],
): Promise<Map<string, SportLevelCard[]>> {
  const out = new Map<string, SportLevelCard[]>();
  if (userIds.length === 0) return out;
  const rows = await db.playerSportLevel.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, sport: true, level: true },
    orderBy: [{ userId: 'asc' }, { sport: 'asc' }],
    // A person declares a level for at most every sport there is.
    take: userIds.length * 40,
  });
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ sport: r.sport, level: r.level });
    out.set(r.userId, list);
  }
  return out;
}

/** The ids of everybody in a block with `viewerId`, either way round. */
async function blockedEitherWay(db: PrismaClient, viewerId: string): Promise<string[]> {
  const rows = await db.userBlock.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
    take: 5_000,
  });
  return rows.map((r) => (r.blockerId === viewerId ? r.blockedId : r.blockerId));
}

/**
 * Players by name, for "Ново съобщение" (#375).
 *
 * Everyone by default; never somebody who switched off "Показвай ме в
 * търсенето", never a deleted account, a club or a coach account, never the
 * viewer, and never anybody in a block with the viewer, either way: a person
 * you blocked, or who blocked you, is not somebody this screen offers.
 */
export async function searchPlayers(viewerId: string, query: string): Promise<PlayerCard[]> {
  const q = query.trim().replace(/\s+/g, ' ');
  if (q.length < PLAYER_SEARCH_MIN) return [];
  const pattern = `%${likeEscape(q.slice(0, 80))}%`;

  // guardrail-allow: cross-tenant — app_user is global; the result is the
  // public card only, and the filters below are the opt-out and the blocks.
  return runAsSuperuser(async (db) => {
    const blocked = await blockedEitherWay(db, viewerId);
    const users = await db.$queryRaw<
      Array<{ id: string; name: string | null; avatarUrl: string | null }>
    >`
      SELECT u."id", u."name", u."avatarUrl"
        FROM "app_user" u
       WHERE u."name" ILIKE ${pattern}
         AND u."searchable" = true
         AND u."deletedAt" IS NULL
         AND u."accountKind" = 'PLAYER'
         AND u."id" <> ${viewerId}
         ${blocked.length > 0 ? Prisma.sql`AND u."id" NOT IN (${Prisma.join(blocked)})` : Prisma.empty}
       ORDER BY (lower(u."name") LIKE lower(${`${likeEscape(q)}%`})) DESC, u."name" ASC, u."id" ASC
       LIMIT ${PLAYER_SEARCH_LIMIT}`;
    const sports = await sportsOf(
      db,
      users.map((u) => u.id),
    );
    return users.map((u) => ({
      userId: u.id,
      name: u.name,
      avatarUrl: avatarUrlOf(u.avatarUrl),
      sports: sports.get(u.id) ?? [],
    }));
  });
}

/**
 * What stands between `viewerId` and writing to `targetId` (#375).
 *
 *   exists      a PLAYER account, not deleted
 *   blocked     a block between the two, either way round
 *   played      a booking both of them were on, at any club, not cancelled
 *   searchable  the target lets players find them by name
 *
 * "Stranger" is the owner's word: no shared booking and no accepted
 * conversation. The second half is a fact about the conversation, which the
 * caller reads under RLS (`messaging.ts`), so it is not answered here.
 */
export interface Reachability {
  exists: boolean;
  blocked: boolean;
  played: boolean;
  searchable: boolean;
}

export async function reachability(viewerId: string, targetId: string): Promise<Reachability> {
  // guardrail-allow: cross-tenant — two named people, both ids in hand; the
  // booking read spans clubs because playing together does.
  return runAsSuperuser(async (db) => {
    const target = await db.user.findUnique({
      where: { id: targetId },
      select: { accountKind: true, deletedAt: true, searchable: true },
    });
    if (!target || target.deletedAt || target.accountKind !== 'PLAYER') {
      return { exists: false, blocked: false, played: false, searchable: false };
    }
    const [block, shared] = await Promise.all([
      db.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: targetId },
            { blockerId: targetId, blockedId: viewerId },
          ],
        },
        select: { blockerId: true },
      }),
      db.$queryRaw<Array<{ played: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM "booking" b
           WHERE b."status" <> 'CANCELLED'
             AND (b."bookedByUserId" = ${viewerId}
                  OR EXISTS (SELECT 1 FROM "booking_participant" p
                              WHERE p."bookingId" = b."id" AND p."userId" = ${viewerId}))
             AND (b."bookedByUserId" = ${targetId}
                  OR EXISTS (SELECT 1 FROM "booking_participant" p
                              WHERE p."bookingId" = b."id" AND p."userId" = ${targetId}))
        ) AS "played"`,
    ]);
    return {
      exists: true,
      blocked: block !== null,
      played: shared[0]?.played === true,
      searchable: target.searchable,
    };
  });
}

/** A player's public card, by id, with no access decision: the caller makes it. */
export async function playerCardById(targetId: string): Promise<PlayerCard | null> {
  // guardrail-allow: cross-tenant — one person by id; the public card only.
  return runAsSuperuser(async (db) => {
    const u = await db.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, avatarUrl: true, accountKind: true, deletedAt: true },
    });
    if (!u || u.deletedAt || u.accountKind !== 'PLAYER') return null;
    const sports = await sportsOf(db, [u.id]);
    return {
      userId: u.id,
      name: u.name,
      avatarUrl: avatarUrlOf(u.avatarUrl),
      sports: sports.get(u.id) ?? [],
    };
  });
}

/**
 * The names on a page of conversations or messages: people by id and clubs by
 * id, one read each. The ids come from rows RLS already let the caller see, so
 * this cannot widen what they know beyond the names of the people and clubs
 * they are talking to.
 */
export async function namesFor(input: {
  userIds: readonly string[];
  tenantIds: readonly string[];
}): Promise<{ people: Map<string, PersonName>; clubs: Map<string, ClubName> }> {
  const userIds = [...new Set(input.userIds)];
  const tenantIds = [...new Set(input.tenantIds)];
  // guardrail-allow: cross-tenant — names by id, ids from an RLS-bound page.
  const [users, clubs] = await runAsSuperuser((db) =>
    Promise.all([
      userIds.length === 0
        ? Promise.resolve([])
        : db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, avatarUrl: true, deletedAt: true },
            take: userIds.length,
          }),
      tenantIds.length === 0
        ? Promise.resolve([])
        : db.venueOrg.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, slug: true, name: true },
            take: tenantIds.length,
          }),
    ]),
  );
  return {
    people: new Map(
      users.map((u) => [
        u.id,
        {
          userId: u.id,
          name: u.deletedAt ? null : u.name,
          avatarUrl: u.deletedAt ? null : avatarUrlOf(u.avatarUrl),
          deleted: u.deletedAt !== null,
        },
      ]),
    ),
    clubs: new Map(clubs.map((c) => [c.id, { tenantId: c.id, slug: c.slug, name: c.name }])),
  };
}

/** Who to tell about a new message, and what to call the sender. */
export interface MessageAudience {
  type: 'DM' | 'CLUB';
  /** The club of a CLUB conversation. */
  club: ClubName | null;
  /** A DM that is still a request (the bell says so). */
  request: boolean;
  senderName: string | null;
  /** The sender wrote for the club. */
  fromClub: boolean;
  recipients: Array<{
    userId: string;
    locale: string;
    /** Staff read the club's inbox; a player reads their own. */
    side: 'player' | 'club';
    /** Their read pointer: the bell says one thing per unread stretch. */
    lastReadAt: Date | null;
  }>;
}

/**
 * The people a new message is news to (#375): the other player of a DM; the
 * player of a CLUB conversation when the club wrote; and when the player
 * wrote, every ACTIVE OWNER, MANAGER and STAFF of the club — the same people
 * the P54 policy lets read it, so nobody is told about a conversation that
 * would then answer them 404. Never the sender, never a deleted account.
 *
 * Read AFTER the message committed (`notifyNewMessage`). The recipients' own
 * rows — memberships at the club, other people's read pointers — are no one
 * RLS binding's, so this one reads them.
 */
export async function messageAudience(
  conversationId: string,
  senderUserId: string,
): Promise<MessageAudience | null> {
  // guardrail-allow: cross-tenant — one conversation by id, just written to,
  // and the people the P54 policy admits to it.
  return runAsSuperuser(async (db) => {
    const c = await db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        type: true,
        tenantId: true,
        playerUserId: true,
        acceptedAt: true,
        participants: { select: { userId: true, role: true, lastReadAt: true }, take: 100 },
      },
    });
    if (!c || (c.type !== 'DM' && c.type !== 'CLUB')) return null;

    const pointer = new Map(c.participants.map((p) => [p.userId, p.lastReadAt]));
    const fromClub = c.type === 'CLUB' && senderUserId !== c.playerUserId;

    let ids: Array<{ userId: string; side: 'player' | 'club' }>;
    if (c.type === 'DM') {
      ids = c.participants
        .filter((p) => p.role === 'MEMBER' && p.userId !== senderUserId)
        .map((p) => ({ userId: p.userId, side: 'player' as const }));
    } else if (fromClub) {
      ids = c.playerUserId ? [{ userId: c.playerUserId, side: 'player' }] : [];
    } else {
      const staff = c.tenantId
        ? await db.tenantMembership.findMany({
            where: {
              tenantId: c.tenantId,
              status: 'ACTIVE',
              role: { in: ['OWNER', 'MANAGER', 'STAFF'] },
            },
            select: { userId: true },
            take: 100,
          })
        : [];
      ids = staff.map((m) => ({ userId: m.userId, side: 'club' as const }));
    }

    const userIds = [...new Set([senderUserId, ...ids.map((i) => i.userId)])];
    const [users, club] = await Promise.all([
      db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, locale: true, deletedAt: true },
        take: userIds.length,
      }),
      c.tenantId
        ? db.venueOrg.findUnique({
            where: { id: c.tenantId },
            select: { id: true, slug: true, name: true },
          })
        : Promise.resolve(null),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const sender = byId.get(senderUserId);

    return {
      type: c.type,
      club: club ? { tenantId: club.id, slug: club.slug, name: club.name } : null,
      request: c.type === 'DM' && c.acceptedAt === null,
      senderName: sender && !sender.deletedAt ? sender.name : null,
      fromClub,
      recipients: ids.flatMap((i) => {
        const u = byId.get(i.userId);
        if (!u || u.deletedAt || i.userId === senderUserId) return [];
        return [
          {
            userId: i.userId,
            locale: u.locale,
            side: i.side,
            lastReadAt: pointer.get(i.userId) ?? null,
          },
        ];
      }),
    };
  });
}

/**
 * Who is at a place on one of the caller's bookings (#375): the booker for
 * `participantId: null`, else that added player. Null unless the caller is on
 * the booking themselves (its booker, or a player on it), the place holds a
 * person with an account, and that person is not the caller.
 */
export async function coPlayerAt(
  viewerId: string,
  bookingId: string,
  participantId: string | null,
): Promise<string | null> {
  // guardrail-allow: cross-tenant — one booking by id, kept only if the
  // caller is on it; its players, as the booking's own player list shows them.
  const b = await runAsSuperuser((db) =>
    db.booking.findUnique({
      where: { id: bookingId },
      select: {
        bookedByUserId: true,
        participants: { select: { id: true, userId: true }, take: 100 },
      },
    }),
  );
  if (!b) return null;
  const onIt = b.bookedByUserId === viewerId || b.participants.some((p) => p.userId === viewerId);
  if (!onIt) return null;
  const target =
    participantId === null
      ? b.bookedByUserId
      : (b.participants.find((p) => p.id === participantId)?.userId ?? null);
  return target && target !== viewerId ? target : null;
}

/**
 * File a report into the platform's moderation queue (#375): the content
 * report, and the one OPEN case for the subject (`reportContent`, the review
 * queue's own writer). Platform-level, with no club: a report about a club's
 * reply is for the platform to judge, not for that club's staff to read. The
 * caller has already proved the reporter can read the subject.
 */
export async function fileChatReport(input: {
  subjectType: 'CHAT_MESSAGE' | 'CONVERSATION';
  subjectId: string;
  reporterUserId: string;
  reason: string;
}): Promise<{ caseId: string }> {
  // guardrail-allow: cross-tenant — one report and its case, platform-level
  // (no club), about a subject the reporter was shown under RLS.
  return runAsSuperuser((db) => reportContent(db, input));
}

/** A club a player can write to: active, by its slug. */
export async function activeClubBySlug(slug: string): Promise<ClubName | null> {
  // guardrail-allow: cross-tenant — one club by its public slug, as its public page reads it.
  const club = await runAsSuperuser((db) =>
    db.venueOrg.findUnique({
      where: { slug },
      select: { id: true, slug: true, name: true, status: true },
    }),
  );
  if (!club || club.status !== 'ACTIVE') return null;
  return { tenantId: club.id, slug: club.slug, name: club.name };
}

/** Whether `userId` is a PLAYER account that is not deleted. */
export async function isLivePlayer(userId: string): Promise<boolean> {
  // guardrail-allow: cross-tenant — the caller's own account row.
  const u = await runAsSuperuser((db) =>
    db.user.findUnique({ where: { id: userId }, select: { accountKind: true, deletedAt: true } }),
  );
  return !!u && !u.deletedAt && u.accountKind === 'PLAYER';
}
