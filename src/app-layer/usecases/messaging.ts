import { randomInt } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { isUniqueViolation } from '@/lib/db/pg-errors';
import { runAsUserOnly, runInUserContext } from '@/lib/db/rls-middleware';
import { AppError, RateLimitedError } from '@/lib/errors/types';
import { decodeCursor, encodeCursor, keysetBefore } from '@/lib/messaging/cursor';
import { MAX_BODY_LENGTH } from '@/lib/messaging/limits';
import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from '@/lib/messaging/report';
import { logger } from '@/lib/observability/logger';
import { decryptField, encryptField } from '@/lib/security/encryption';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { sanitizePlainText } from '@/lib/security/sanitize';

import {
  activeClubBySlug,
  coPlayerAt,
  fileChatReport,
  isLivePlayer,
  namesFor,
  playerCardById,
  reachability,
  searchPlayers,
  type ClubName,
  type PersonName,
  type PlayerCard,
} from './messaging-directory';
import { notifyNewMessage } from './messaging-notify';

/**
 * Messaging, module 1 (#375), ported from Agrent's exchange messaging
 * (agri-saas `usecases/exchange-messaging.ts`) onto P15's Conversation model.
 *
 * ═══ TWO KINDS OF CONVERSATION ═══
 *
 *   DM    player ↔ player. Anyone finds anyone by name, unless they switched
 *         off "Показвай ме в търсенето"; a STRANGER (no shared booking, no
 *         accepted conversation) gets one message, a REQUEST in «Заявки»,
 *         until the recipient accepts or answers it.
 *   CLUB  player ↔ club. The club side is the club: every active OWNER,
 *         MANAGER and STAFF reads one shared inbox, and each reply names who
 *         wrote it («Иван · Тенис клуб Левски»). A player may write to any
 *         club; a club may START one only with a player on its Играчи list.
 *
 * ═══ WHO MAY READ: RLS, BY PERSON ═══
 *
 * Every read and write here runs in an RLS binding that names the PERSON
 * (`app.user_id`): `runAsUserOnly` for a player, `runInUserContext` (the club
 * AND the person) for staff. The P54 policies admit a conversation's own
 * players, and for a CLUB conversation its club's staff — never "whoever is
 * bound to the club", which a player's own booking also is. The checks below
 * are how the code knows WHICH side is asking; the policies are the boundary.
 *
 * ═══ PERSIST, NEVER PUBLISH FROM HERE ═══
 *
 * There is no broker. Postgres is the source of truth and delivery is the
 * open screen's 5-second refresh (`ConversationView`). Publish-then-persist
 * looks equivalent and is not: the message flashes up, the write fails, and it
 * is gone on refresh. When a transport is added, it subscribes to what
 * `notifyNewMessage` is told AFTER the commit; nothing here changes.
 *
 * ═══ NOTIFY AFTER COMMIT ═══
 *
 * Agrent's notify ran inside the sender's transaction: the bell was durable
 * (and pushed) while the message could still roll back, and every send held
 * two pool connections (agri-saas #1203). Here the use case OWNS its
 * transaction, so "after commit" is simply after it returns: `sendMessage`
 * awaits its binding, then notifies.
 *
 * ═══ BODIES ARE CIPHERTEXT ═══
 *
 * Sanitised (`sanitizePlainText`), measured, then sealed with `encryptField`:
 * the `v1:` envelope under the GLOBAL key from DATA_ENCRYPTION_KEY, so both
 * sides read what either wrote (agri-saas #1248 — a per-tenant key left the
 * recipient reading ciphertext). RLS decides who sees the row; the key decides
 * what a stolen database yields.
 */

// ─── Limits ─────────────────────────────────────────────────────────────

/** See `src/lib/messaging/limits.ts`: the spec is pinned to it. */
export { MAX_BODY_LENGTH };
/** One page of an inbox, or of scrollback. */
export const PAGE_SIZE = 50;
/** The characters of the last message an inbox row shows. */
export const PREVIEW_LENGTH = 140;

/**
 * Sends per SENDER per minute (agri-saas #1162). Keyed on the person, never
 * the IP: a sender on three networks is one sender. For a club it is the CLUB,
 * because the flood lands on one player's bell whichever colleague types.
 */
export const MESSAGE_SEND_LIMIT: RateLimitConfig = { maxAttempts: 30, windowMs: 60_000 };
/**
 * New requests to strangers per player per day. A request is one message to
 * somebody who never played with you; twenty a day is a social life, more is
 * a mailing list.
 */
export const MESSAGE_REQUEST_LIMIT: RateLimitConfig = {
  maxAttempts: 20,
  windowMs: 24 * 3_600_000,
};

// ─── Who is asking ──────────────────────────────────────────────────────

/** A player as themselves, or a staff member for their club. */
export type MessagingActor =
  { kind: 'player'; userId: string } | { kind: 'club'; userId: string; tenantId: string };

function bound<T>(actor: MessagingActor, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return actor.kind === 'club'
    ? runInUserContext({ tenantId: actor.tenantId, userId: actor.userId }, fn)
    : runAsUserOnly(actor.userId, fn);
}

// ─── Errors ─────────────────────────────────────────────────────────────

/** A refusal with a stable code a client can switch on. */
export class MessagingError extends AppError {
  constructor(code: string, status: number, message: string) {
    super(message, code, status, true);
    this.name = 'MessagingError';
  }
}

const notFound = () =>
  new MessagingError('CONVERSATION_NOT_FOUND', 404, 'That conversation was not found.');
const playerNotFound = () =>
  new MessagingError('PLAYER_NOT_FOUND', 404, 'That player was not found.');

async function assertLivePlayer(actor: MessagingActor): Promise<void> {
  if (actor.kind !== 'player') return;
  if (!(await isLivePlayer(actor.userId))) {
    // Coach conversations wait for the coach module (#377); a club writes
    // from its own inbox.
    throw new MessagingError(
      'PLAYER_ACCOUNT_REQUIRED',
      403,
      'Messages between players need a player account.',
    );
  }
}

async function enforceRate(key: string, config: RateLimitConfig): Promise<void> {
  if (isRateLimitBypassed()) return;
  const r = await checkRateLimit(key, config);
  if (!r.allowed) throw new RateLimitedError('Too many messages. Wait a moment and try again.');
}

// ─── Views ──────────────────────────────────────────────────────────────

export type ConversationKind = 'player' | 'club';

/**
 * Where a conversation stands for the CALLER.
 *
 *   active    both may write
 *   pending   the caller's request, waiting (also after a quiet decline)
 *   request   somebody's request to the caller, in «Заявки»
 *   declined  a request the caller declined: answering it accepts it after all
 *   blocked   a block stops it, either way
 *   closed    the other side deleted their account
 */
export type ConversationState =
  'active' | 'pending' | 'request' | 'declined' | 'blocked' | 'closed';

/** The other side of a conversation, as the caller sees it. */
export type Counterpart =
  | {
      kind: 'player';
      userId: string;
      name: string | null;
      avatarUrl: string | null;
      deleted: boolean;
    }
  | { kind: 'club'; clubId: string; slug: string; name: string };

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  counterpart: Counterpart;
  state: ConversationState;
  lastMessageAt: Date;
  lastMessage: { preview: string | null; mine: boolean; deleted: boolean } | null;
  unreadCount: number;
}

export interface MessageView {
  id: string;
  /** Sent by the caller, the person. */
  mine: boolean;
  /** Written for the club (a staff reply), whoever reads it. */
  fromClub: boolean;
  /** Every sender is named (agri-saas #1399); a deleted account as such. */
  sender: { name: string | null; deleted: boolean; clubName: string | null };
  /** Null for a retracted message: a tombstone keeps its place. */
  body: string | null;
  deleted: boolean;
  createdAt: Date;
}

export interface ConversationView {
  id: string;
  kind: ConversationKind;
  counterpart: Counterpart;
  state: ConversationState;
  /** The caller pressed the block (they can lift it). */
  blockedByMe: boolean;
  /** Whether the composer may send now. The server decides again on send. */
  canSend: boolean;
  unreadCount: number;
  /** Opaque position of the next OLDER page, or null at the start. */
  olderCursor: string | null;
  messages: MessageView[];
}

export interface InboxPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

// ─── Reading a conversation's row, as the caller ────────────────────────

const CONVERSATION_SELECT = {
  id: true,
  type: true,
  tenantId: true,
  createdById: true,
  playerUserId: true,
  acceptedAt: true,
  declinedAt: true,
  blockedAt: true,
  blockedSide: true,
  blockedByUserId: true,
  lastMessageAt: true,
  participants: {
    select: { userId: true, role: true, lastReadAt: true },
    take: 50,
  },
} satisfies Prisma.ConversationSelect;

type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>;

/** The person on the far side of a DM, or a club conversation's player for its staff. */
function otherPersonOf(c: ConversationRow, actor: MessagingActor): string | null {
  if (c.type === 'DM') {
    return (
      c.participants.find((p) => p.role === 'MEMBER' && p.userId !== actor.userId)?.userId ?? null
    );
  }
  return actor.kind === 'club' ? c.playerUserId : null;
}

/** People who have blocked the caller: they are hidden from the caller, silently. */
async function whoBlockedMe(db: PrismaClient, actor: MessagingActor): Promise<string[]> {
  if (actor.kind !== 'player') return [];
  const rows = await db.userBlock.findMany({
    where: { blockedId: actor.userId },
    select: { blockerId: true },
    take: 5_000,
  });
  return rows.map((r) => r.blockerId);
}

/**
 * The conversation, if the caller may see it, or CONVERSATION_NOT_FOUND.
 *
 * RLS has already refused a third party (the row does not come back). This
 * resolves which SIDE is asking, and hides a DM from somebody the other player
 * has blocked — with the same 404, deliberately: a distinguishable code would
 * tell the blocked person exactly what a message would (agri-saas P5.2b).
 */
async function requireConversation(
  db: PrismaClient,
  actor: MessagingActor,
  conversationId: string,
): Promise<ConversationRow> {
  const c = await db.conversation.findFirst({
    where: {
      id: conversationId,
      ...(actor.kind === 'club'
        ? { type: 'CLUB' as const, tenantId: actor.tenantId }
        : {
            type: { in: ['DM' as const, 'CLUB' as const] },
            participants: { some: { userId: actor.userId, role: { in: ['MEMBER', 'PLAYER'] } } },
          }),
    },
    select: CONVERSATION_SELECT,
  });
  if (!c) throw notFound();

  if (c.type === 'DM') {
    const other = otherPersonOf(c, actor);
    if (other) {
      const hidden = await db.userBlock.findFirst({
        where: { blockerId: other, blockedId: actor.userId },
        select: { blockerId: true },
      });
      if (hidden) throw notFound();
    }
  }
  return c;
}

/** The caller's own pointer row, if any. */
function myRow(c: ConversationRow, actor: MessagingActor) {
  return c.participants.find((p) => p.userId === actor.userId) ?? null;
}

/**
 * Where the conversation stands for the caller, and whether they may write.
 * `iBlocked` is a DM's person block by the caller; the reverse never reaches
 * here (the conversation is hidden from them).
 */
function standing(
  c: ConversationRow,
  actor: MessagingActor,
  facts: { iBlocked: boolean; otherDeleted: boolean; iHaveSent: boolean },
): { state: ConversationState; blockedByMe: boolean; canSend: boolean } {
  if (facts.otherDeleted) return { state: 'closed', blockedByMe: false, canSend: false };
  // A moderator closed it after a report (P55): for both sides, for good.
  if (c.blockedAt && c.blockedSide === 'PLATFORM') {
    return { state: 'blocked', blockedByMe: false, canSend: false };
  }

  if (c.type === 'CLUB') {
    if (c.blockedAt) {
      const mySide = actor.kind === 'club' ? 'CLUB' : 'PLAYER';
      return { state: 'blocked', blockedByMe: c.blockedSide === mySide, canSend: false };
    }
    return { state: 'active', blockedByMe: false, canSend: true };
  }

  if (facts.iBlocked) return { state: 'blocked', blockedByMe: true, canSend: false };
  if (c.acceptedAt) return { state: 'active', blockedByMe: false, canSend: true };

  const iAmRequester = c.createdById === actor.userId;
  if (iAmRequester) {
    // One message until it is accepted; a decline changes nothing the sender sees.
    return { state: 'pending', blockedByMe: false, canSend: !facts.iHaveSent && !c.declinedAt };
  }
  return { state: c.declinedAt ? 'declined' : 'request', blockedByMe: false, canSend: true };
}

function decryptBody(stored: string): string | null {
  if (!stored) return null;
  try {
    return decryptField(stored);
  } catch (err) {
    // A body that will not open is shown as nothing rather than as ciphertext
    // or a 500 for the whole conversation. Logged without the value.
    logger.warn('message body did not decrypt', {
      component: 'messaging',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function counterpartOf(
  c: Pick<ConversationRow, 'type' | 'tenantId' | 'playerUserId'> & { otherUserId: string | null },
  actor: MessagingActor,
  names: { people: Map<string, PersonName>; clubs: Map<string, ClubName> },
): Counterpart {
  if (c.type === 'CLUB' && actor.kind === 'player') {
    const club = c.tenantId ? names.clubs.get(c.tenantId) : undefined;
    return {
      kind: 'club',
      clubId: c.tenantId ?? '',
      slug: club?.slug ?? '',
      name: club?.name ?? '',
    };
  }
  const id = c.otherUserId ?? '';
  const p = names.people.get(id);
  return {
    kind: 'player',
    userId: id,
    name: p?.name ?? null,
    avatarUrl: p?.avatarUrl ?? null,
    deleted: p?.deleted ?? true,
  };
}

// ─── The inbox ──────────────────────────────────────────────────────────

/**
 * Unread counts for a page of conversations, counted in the DATABASE: a count
 * over the fetched page would cap the badge at the page size (agri-saas #1298).
 * "Not mine" is the PERSON for a player, and the PLAYER's messages for staff —
 * a colleague's reply is the club's own words, not something to read.
 */
async function unreadCounts(
  db: PrismaClient,
  actor: MessagingActor,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const notMine =
    actor.kind === 'club'
      ? Prisma.sql`m."senderTenantId" IS NULL`
      : Prisma.sql`m."senderId" <> ${actor.userId}`;
  const rows = await db.$queryRaw<Array<{ conversationId: string; n: number }>>`
    SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS "n"
      FROM "chat_message" m
      LEFT JOIN "conversation_participant" me
        ON me."conversationId" = m."conversationId" AND me."userId" = ${actor.userId}
     WHERE m."conversationId" IN (${Prisma.join(ids)})
       AND m."deletedAt" IS NULL
       AND ${notMine}
       AND (me."lastReadAt" IS NULL OR m."createdAt" > me."lastReadAt")
     GROUP BY m."conversationId"`;
  return new Map(rows.map((r) => [r.conversationId, r.n]));
}

interface LastMessageRow {
  conversationId: string;
  senderId: string;
  body: string;
  deletedAt: Date | null;
}

async function lastMessages(db: PrismaClient, ids: string[]): Promise<Map<string, LastMessageRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<LastMessageRow[]>`
    SELECT DISTINCT ON (m."conversationId")
           m."conversationId", m."senderId", m."body", m."deletedAt"
      FROM "chat_message" m
     WHERE m."conversationId" IN (${Prisma.join(ids)})
     ORDER BY m."conversationId", m."createdAt" DESC, m."id" DESC`;
  return new Map(rows.map((r) => [r.conversationId, r]));
}

function preview(text: string | null): string | null {
  if (text === null) return null;
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > PREVIEW_LENGTH ? `${one.slice(0, PREVIEW_LENGTH - 1)}…` : one;
}

export type InboxTab = 'conversations' | 'requests';

/**
 * The caller's conversations, most recently active first, with unread counts.
 *
 * For a player, `tab` splits «Заявки» (requests TO them, not yet accepted or
 * declined) from everything else, which includes their own requests waiting.
 * A conversation nobody has written in yet is in neither: opening one is not
 * saying something. A DM whose other player has blocked the caller is excluded
 * IN THE QUERY, never filtered from the page afterwards: the page is read as
 * `limit + 1` rows to learn whether there is another, and dropping rows after
 * that would make `nextCursor` wrong.
 *
 * For a club, the club's whole inbox: every CLUB conversation of the club.
 */
export async function listConversations(
  actor: MessagingActor,
  opts: { tab?: InboxTab; cursor?: string | null; limit?: number } = {},
): Promise<InboxPage> {
  const limit = Math.min(
    Math.max(Number.isFinite(opts.limit) ? (opts.limit as number) : PAGE_SIZE, 1),
    PAGE_SIZE,
  );
  const cursor = decodeCursor(opts.cursor);
  const tab = opts.tab ?? 'conversations';

  const page = await bound(actor, async (db) => {
    const blockers = await whoBlockedMe(db, actor);
    const scope: Prisma.ConversationWhereInput =
      actor.kind === 'club'
        ? { type: 'CLUB', tenantId: actor.tenantId }
        : {
            type: { in: ['DM', 'CLUB'] },
            participants: { some: { userId: actor.userId, role: { in: ['MEMBER', 'PLAYER'] } } },
          };
    const and: Prisma.ConversationWhereInput[] = [];
    if (actor.kind === 'player') {
      and.push(
        tab === 'requests'
          ? { type: 'DM', acceptedAt: null, declinedAt: null, createdById: { not: actor.userId } }
          : { OR: [{ acceptedAt: { not: null } }, { createdById: actor.userId }] },
      );
      if (blockers.length > 0) {
        and.push({ NOT: { type: 'DM', participants: { some: { userId: { in: blockers } } } } });
      }
    }
    if (cursor) and.push(keysetBefore(cursor, 'lastMessageAt'));

    const rows = await db.conversation.findMany({
      where: { ...scope, messages: { some: {} }, AND: and },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: CONVERSATION_SELECT,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const ids = pageRows.map((r) => r.id);

    const others = pageRows.flatMap((c) => {
      const o = otherPersonOf(c, actor);
      return o ? [o] : [];
    });
    const [unread, last, myBlocks] = await Promise.all([
      unreadCounts(db, actor, ids),
      lastMessages(db, ids),
      actor.kind === 'player' && others.length > 0
        ? db.userBlock.findMany({
            where: { blockerId: actor.userId, blockedId: { in: others } },
            select: { blockedId: true },
            take: others.length,
          })
        : Promise.resolve([]),
    ]);
    return {
      rows: pageRows,
      hasMore,
      unread,
      last,
      iBlocked: new Set(myBlocks.map((b) => b.blockedId)),
    };
  });

  const names = await namesFor({
    userIds: page.rows.flatMap((c) => {
      const o = otherPersonOf(c, actor);
      return o ? [o] : [];
    }),
    tenantIds: page.rows.flatMap((c) => (c.type === 'CLUB' && c.tenantId ? [c.tenantId] : [])),
  });

  const items = page.rows.map((c): ConversationSummary => {
    const otherUserId = otherPersonOf(c, actor);
    const counterpart = counterpartOf({ ...c, otherUserId }, actor, names);
    const last = page.last.get(c.id);
    const { state } = standing(c, actor, {
      iBlocked: otherUserId ? page.iBlocked.has(otherUserId) : false,
      otherDeleted: counterpart.kind === 'player' && counterpart.deleted,
      // The list does not need canSend; whether the caller wrote is the
      // thread's question.
      iHaveSent: false,
    });
    return {
      id: c.id,
      kind: c.type === 'CLUB' ? 'club' : 'player',
      counterpart,
      state,
      lastMessageAt: c.lastMessageAt,
      lastMessage: last
        ? {
            preview: last.deletedAt ? null : preview(decryptBody(last.body)),
            mine: last.senderId === actor.userId,
            deleted: last.deletedAt !== null,
          }
        : null,
      unreadCount: page.unread.get(c.id) ?? 0,
    };
  });

  const lastRow = page.rows.at(-1);
  return {
    items,
    nextCursor:
      page.hasMore && lastRow ? encodeCursor({ at: lastRow.lastMessageAt, id: lastRow.id }) : null,
  };
}

/**
 * How much is waiting, for the header's badge: conversations with something
 * unread, and requests with something unread. Two numbers rather than one so
 * the «Заявки» tab can carry its own.
 */
export async function unreadSummary(
  actor: MessagingActor,
): Promise<{ conversations: number; requests: number }> {
  return bound(actor, async (db) => {
    if (actor.kind === 'club') {
      const rows = await db.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS "n"
          FROM "conversation" c
          LEFT JOIN "conversation_participant" me
            ON me."conversationId" = c."id" AND me."userId" = ${actor.userId}
         WHERE c."tenantId" = ${actor.tenantId}
           AND c."type"::text = 'CLUB'
           AND EXISTS (
             SELECT 1 FROM "chat_message" m
              WHERE m."conversationId" = c."id"
                AND m."deletedAt" IS NULL
                AND m."senderTenantId" IS NULL
                AND (me."lastReadAt" IS NULL OR m."createdAt" > me."lastReadAt"))`;
      return { conversations: rows[0]?.n ?? 0, requests: 0 };
    }
    const rows = await db.$queryRaw<Array<{ conversations: number; requests: number }>>`
      SELECT
        COUNT(*) FILTER (WHERE c."acceptedAt" IS NOT NULL OR c."createdById" = ${actor.userId})::int AS "conversations",
        COUNT(*) FILTER (WHERE c."acceptedAt" IS NULL AND c."declinedAt" IS NULL
                           AND c."createdById" <> ${actor.userId})::int AS "requests"
        FROM "conversation" c
        JOIN "conversation_participant" me
          ON me."conversationId" = c."id" AND me."userId" = ${actor.userId}
         AND me."role" IN ('MEMBER', 'PLAYER')
       WHERE c."type"::text IN ('DM', 'CLUB')
         AND EXISTS (
           SELECT 1 FROM "chat_message" m
            WHERE m."conversationId" = c."id"
              AND m."deletedAt" IS NULL
              AND m."senderId" <> ${actor.userId}
              AND (me."lastReadAt" IS NULL OR m."createdAt" > me."lastReadAt"))
         AND NOT (
           c."type"::text = 'DM' AND EXISTS (
             SELECT 1 FROM "user_block" b
               JOIN "conversation_participant" o
                 ON o."conversationId" = c."id" AND o."userId" = b."blockerId"
              WHERE b."blockedId" = ${actor.userId}))`;
    return { conversations: rows[0]?.conversations ?? 0, requests: rows[0]?.requests ?? 0 };
  });
}

// ─── One conversation ───────────────────────────────────────────────────

/**
 * The conversation with its newest page of scrollback, oldest first (reading
 * order), or the page before `before`.
 */
export async function getConversation(
  actor: MessagingActor,
  conversationId: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<ConversationView> {
  const limit = Math.min(
    Math.max(Number.isFinite(opts.limit) ? (opts.limit as number) : PAGE_SIZE, 1),
    PAGE_SIZE,
  );
  const before = decodeCursor(opts.before);

  const read = await bound(actor, async (db) => {
    const c = await requireConversation(db, actor, conversationId);
    const me = myRow(c, actor);
    const other = otherPersonOf(c, actor);

    const rows = await db.chatMessage.findMany({
      where: { conversationId, ...(before ? keysetBefore(before, 'createdAt') : {}) },
      // `id` tiebreaks: two messages in one millisecond are otherwise not
      // ordered, and the pair straddling a page boundary loses one line and
      // repeats the other.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        senderId: true,
        senderTenantId: true,
        body: true,
        deletedAt: true,
        createdAt: true,
      },
    });
    const [unread, iBlocked, iHaveSent] = await Promise.all([
      unreadCounts(db, actor, [conversationId]),
      c.type === 'DM' && other && actor.kind === 'player'
        ? db.userBlock
            .findFirst({
              where: { blockerId: actor.userId, blockedId: other },
              select: { blockedId: true },
            })
            .then((b) => b !== null)
        : Promise.resolve(false),
      c.type === 'DM' && !c.acceptedAt && c.createdById === actor.userId
        ? db.chatMessage
            .count({ where: { conversationId, senderId: actor.userId } })
            .then((n) => n > 0)
        : Promise.resolve(false),
    ]);
    return { c, me, other, rows, unread: unread.get(conversationId) ?? 0, iBlocked, iHaveSent };
  });

  const hasOlder = read.rows.length > limit;
  const page = hasOlder ? read.rows.slice(0, limit) : read.rows;
  const oldest = page.at(-1);

  const names = await namesFor({
    userIds: [...page.map((m) => m.senderId), ...(read.other ? [read.other] : [])],
    tenantIds: [
      ...(read.c.tenantId ? [read.c.tenantId] : []),
      ...page.flatMap((m) => (m.senderTenantId ? [m.senderTenantId] : [])),
    ],
  });
  const counterpart = counterpartOf({ ...read.c, otherUserId: read.other }, actor, names);
  const st = standing(read.c, actor, {
    iBlocked: read.iBlocked,
    otherDeleted: counterpart.kind === 'player' && counterpart.deleted,
    iHaveSent: read.iHaveSent,
  });

  return {
    id: read.c.id,
    kind: read.c.type === 'CLUB' ? 'club' : 'player',
    counterpart,
    ...st,
    unreadCount: read.unread,
    olderCursor: hasOlder && oldest ? encodeCursor({ at: oldest.createdAt, id: oldest.id }) : null,
    // Reversed: the query takes the NEWEST page, the screen reads oldest first.
    messages: [...page].reverse().map((m): MessageView => {
      const person = names.people.get(m.senderId);
      return {
        id: m.id,
        mine: m.senderId === actor.userId,
        fromClub: m.senderTenantId !== null,
        sender: {
          name: person?.name ?? null,
          deleted: person?.deleted ?? true,
          clubName: m.senderTenantId ? (names.clubs.get(m.senderTenantId)?.name ?? null) : null,
        },
        body: m.deletedAt ? null : decryptBody(m.body),
        deleted: m.deletedAt !== null,
        createdAt: m.createdAt,
      };
    }),
  };
}

// ─── Starting one ───────────────────────────────────────────────────────

/**
 * Create the conversation for `pairKey`, or find the one that exists.
 *
 * `createMany` + `skipDuplicates`, NOT `create`, and that is correctness, not
 * style (agri-saas #1418): two opens racing for one pair both miss the read,
 * and `create` would raise P2002 — which ABORTS the interactive transaction,
 * so the loser could not even read the winner's row and answered 500 (a 409
 * once caught) for a conversation that exists. `ON CONFLICT DO NOTHING` never
 * throws; `count` says which call inserted. Only the inserter writes the
 * participant rows (the creator's prerogative under RLS), in the same
 * transaction, so the loser — waiting on the unique index until the winner
 * commits — reads back a conversation that is already whole.
 */
async function createOrFind(
  db: PrismaClient,
  data: {
    pairKey: string;
    type: 'DM' | 'CLUB';
    tenantId: string | null;
    playerUserId: string | null;
    createdById: string;
    acceptedAt: Date | null;
    participants: Array<{ userId: string; role: 'MEMBER' | 'PLAYER' }>;
  },
): Promise<{ id: string; created: boolean }> {
  // The id is made here, not by the database: the row cannot be READ back
  // until its participant rows exist (that is the policy), so an INSERT …
  // RETURNING, or a read by key, would come back empty for the creator.
  const id = newConversationId();
  const inserted = await db.conversation.createMany({
    data: [
      {
        id,
        type: data.type,
        tenantId: data.tenantId,
        playerUserId: data.playerUserId,
        createdById: data.createdById,
        pairKey: data.pairKey,
        acceptedAt: data.acceptedAt,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 1) {
    await db.conversationParticipant.createMany({
      data: data.participants.map((p) => ({ conversationId: id, userId: p.userId, role: p.role })),
      skipDuplicates: true,
    });
    return { id, created: true };
  }
  const existing = await db.conversation.findFirst({
    where: { pairKey: data.pairKey },
    select: { id: true },
  });
  // The winner of a race made it, with this caller in it, and committed
  // before ON CONFLICT let this statement go on. Absent means the caller is not
  // in the conversation the key names, which the key's shape rules out.
  if (!existing) throw notFound();
  return { id: existing.id, created: false };
}

/** A cuid-shaped id (`c` + 24 base-36 characters), as `@default(cuid())` makes. */
function newConversationId(): string {
  let out = 'c';
  // `randomInt` draws each character uniformly; a byte taken modulo 36 would
  // favour the first few characters.
  for (let i = 0; i < 24; i++) out += randomInt(36).toString(36);
  return out;
}

function dmKey(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

function clubKey(tenantId: string, playerUserId: string): string {
  return `club:${tenantId}:${playerUserId}`;
}

/**
 * A player opens a conversation with another player: the one they already
 * have, or a new one. Idempotent: tapping "Пиши" twice is one conversation.
 *
 * Refused as PLAYER_NOT_FOUND — the same answer as for an id that names
 * nobody — when there is a block either way, or when the target is hidden from
 * search and the two are strangers: neither may be told apart from absence.
 */
export async function openPlayerConversation(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  targetUserId: string,
): Promise<{ id: string; created: boolean }> {
  await assertLivePlayer(actor);
  if (targetUserId === actor.userId) {
    throw new MessagingError('CANNOT_MESSAGE_SELF', 400, 'You cannot message yourself.');
  }
  const reach = await reachability(actor.userId, targetUserId);
  if (!reach.exists || reach.blocked) throw playerNotFound();

  const key = dmKey(actor.userId, targetUserId);
  const existing = await bound(actor, (db) =>
    db.conversation.findFirst({ where: { pairKey: key }, select: { id: true } }),
  );
  if (existing) return { id: existing.id, created: false };

  // Hidden from search: only people they have played with (or already talk
  // to, handled above) may write.
  if (!reach.searchable && !reach.played) throw playerNotFound();

  // A stranger's first message is a REQUEST; somebody you played with is not
  // a stranger.
  const isRequest = !reach.played;
  if (isRequest) await enforceRate(`chat-request:u:${actor.userId}`, MESSAGE_REQUEST_LIMIT);

  return bound(actor, (db) =>
    createOrFind(db, {
      pairKey: key,
      type: 'DM',
      tenantId: null,
      playerUserId: null,
      createdById: actor.userId,
      acceptedAt: isRequest ? null : new Date(),
      participants: [
        { userId: actor.userId, role: 'MEMBER' },
        { userId: targetUserId, role: 'MEMBER' },
      ],
    }),
  );
}

/**
 * "Пиши" on a booking's player list (#375): the conversation with the person
 * at that place, found through the booking so the list never carries a user
 * id. They are on one booking together, so it is not a request unless the
 * booking was cancelled.
 */
export async function openCoPlayerConversation(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  bookingId: string,
  participantId: string | null,
): Promise<{ id: string; created: boolean }> {
  const target = await coPlayerAt(actor.userId, bookingId, participantId);
  if (!target) throw playerNotFound();
  return openPlayerConversation(actor, target);
}

/** A player opens their conversation with a club ("Пиши на клуба"), by the club's slug. */
export async function openClubConversation(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  clubSlug: string,
): Promise<{ id: string; created: boolean }> {
  await assertLivePlayer(actor);
  const club = await activeClubBySlug(clubSlug);
  if (!club) throw new MessagingError('CLUB_NOT_FOUND', 404, 'That club was not found.');

  return bound(actor, (db) =>
    createOrFind(db, {
      pairKey: clubKey(club.tenantId, actor.userId),
      type: 'CLUB',
      tenantId: club.tenantId,
      playerUserId: actor.userId,
      createdById: actor.userId,
      // A club conversation is never a request: writing to a club is what a
      // club is for.
      acceptedAt: new Date(),
      participants: [{ userId: actor.userId, role: 'PLAYER' }],
    }),
  );
}

/**
 * Whether `playerUserId` is on the club's Играчи list: an ACTIVE PLAYER
 * membership, a booking under their account, or the club's own notes on them
 * — the three sources `listPlayers` merges. Read in the club's own binding.
 */
async function isClubPlayer(
  db: PrismaClient,
  tenantId: string,
  playerUserId: string,
): Promise<boolean> {
  const [membership, booking, notes] = await Promise.all([
    db.tenantMembership.findFirst({
      where: { tenantId, userId: playerUserId, role: 'PLAYER', status: 'ACTIVE' },
      select: { id: true },
    }),
    db.booking.findFirst({
      where: { tenantId, bookedByUserId: playerUserId },
      select: { id: true },
    }),
    db.playerVenueRelationship.findFirst({
      where: { tenantId, playerUserId },
      select: { id: true },
    }),
  ]);
  return membership !== null || booking !== null || notes !== null;
}

/**
 * A club's staff open the club's conversation with a player — only one on the
 * club's Играчи list (#375): a club writes to the people who booked there, and
 * to nobody else.
 */
export async function openClubConversationWithPlayer(
  actor: Extract<MessagingActor, { kind: 'club' }>,
  playerUserId: string,
): Promise<{ id: string; created: boolean }> {
  if (!(await isLivePlayer(playerUserId))) throw playerNotFound();
  return bound(actor, async (db) => {
    if (!(await isClubPlayer(db, actor.tenantId, playerUserId))) {
      throw new MessagingError(
        'NOT_A_CLUB_PLAYER',
        403,
        'A club can start a conversation only with a player on its list.',
      );
    }
    return createOrFind(db, {
      pairKey: clubKey(actor.tenantId, playerUserId),
      type: 'CLUB',
      tenantId: actor.tenantId,
      playerUserId,
      createdById: actor.userId,
      acceptedAt: new Date(),
      participants: [{ userId: playerUserId, role: 'PLAYER' }],
    });
  });
}

// ─── Finding a player ───────────────────────────────────────────────────

/** Players by name, for a new conversation: the public card of each (`searchPlayers`). */
export async function findPlayers(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  query: string,
): Promise<PlayerCard[]> {
  await assertLivePlayer(actor);
  return searchPlayers(actor.userId, query);
}

/**
 * One player's public card — name, picture, sports with levels, never an
 * email, a phone or a booking — to anybody who could write to them: everyone,
 * unless they are hidden from search, when only the people they have played
 * with or already talk to. Anyone else, and anyone in a block with them, gets
 * PLAYER_NOT_FOUND, as for an id that names nobody.
 */
export async function viewPlayerCard(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  targetUserId: string,
): Promise<PlayerCard> {
  await assertLivePlayer(actor);
  if (targetUserId !== actor.userId) {
    const reach = await reachability(actor.userId, targetUserId);
    if (!reach.exists || reach.blocked) throw playerNotFound();
    if (!reach.searchable && !reach.played) {
      const talking = await bound(actor, (db) =>
        db.conversation.findFirst({
          where: { pairKey: dmKey(actor.userId, targetUserId) },
          select: { id: true },
        }),
      );
      if (!talking) throw playerNotFound();
    }
  }
  const card = await playerCardById(targetUserId);
  if (!card) throw playerNotFound();
  return card;
}

// ─── Reading pointer ────────────────────────────────────────────────────

/**
 * Move the caller's read pointer to `at`, MONOTONICALLY: a second tab
 * answering late must not rewind it and resurrect messages already read. The
 * guard lives in a conditional `updateMany`, which an upsert cannot express;
 * a staff member's first read creates their own STAFF row. Shared by an
 * explicit read and by sending, which reads up to one's own message.
 *
 * The bell rows about this conversation are marked read with it: having read
 * the conversation, the bell has nothing left to say about it.
 */
async function markReadFor(
  db: PrismaClient,
  actor: MessagingActor,
  conversationId: string,
  at: Date,
): Promise<void> {
  const moved = await db.conversationParticipant.updateMany({
    where: {
      conversationId,
      userId: actor.userId,
      OR: [{ lastReadAt: null }, { lastReadAt: { lt: at } }],
    },
    data: { lastReadAt: at },
  });
  if (moved.count === 0 && actor.kind === 'club') {
    // No row yet, or one already at or past `at`. ON CONFLICT DO NOTHING keeps
    // the newer one, and never aborts the transaction.
    await db.conversationParticipant.createMany({
      data: [{ conversationId, userId: actor.userId, role: 'STAFF', lastReadAt: at }],
      skipDuplicates: true,
    });
  }
  // guardrail-allow: cross-tenant — the caller's own bell rows, owner-only
  // under RLS (`notification_owner_only`); a bell is the person's, not a club's.
  await db.notification.updateMany({
    where: { userId: actor.userId, refType: 'conversation', refId: conversationId, readAt: null },
    data: { readAt: at },
  });
}

/** The caller has read everything up to now. Idempotent and monotonic. */
export async function markConversationRead(
  actor: MessagingActor,
  conversationId: string,
): Promise<{ readAt: Date }> {
  return bound(actor, async (db) => {
    await requireConversation(db, actor, conversationId);
    const now = new Date();
    await markReadFor(db, actor, conversationId, now);
    return { readAt: now };
  });
}

// ─── Saying something ───────────────────────────────────────────────────

export interface SentMessage {
  id: string;
  createdAt: Date;
  /** A retry of a send that already happened: nothing new was said. */
  replayed: boolean;
}

/**
 * Send a message: sanitised, measured, sealed, persisted — and only then, the
 * other side told (`notifyNewMessage`, after the transaction has committed).
 *
 * `idempotencyKey` makes a retry safe: the same key from the same sender
 * returns the first message instead of saying it twice. It is checked FIRST,
 * before any refusal, so that a flaky link cannot turn "delivered" into an
 * error for a message that IS in the conversation.
 */
export async function sendMessage(
  actor: MessagingActor,
  conversationId: string,
  rawBody: string,
  idempotencyKey?: string | null,
): Promise<SentMessage> {
  // Sanitised BEFORE it is measured, so markup cannot smuggle a longer text
  // past the limit.
  const text = sanitizePlainText(rawBody).trim();
  if (!text) throw new MessagingError('MESSAGE_EMPTY', 400, 'Write a message first.');
  if (text.length > MAX_BODY_LENGTH) {
    throw new MessagingError('MESSAGE_TOO_LONG', 400, 'That message is too long.');
  }
  const key = idempotencyKey?.trim() || null;

  await assertLivePlayer(actor);
  await enforceRate(
    actor.kind === 'club' ? `chat-send:club:${actor.tenantId}` : `chat-send:u:${actor.userId}`,
    MESSAGE_SEND_LIMIT,
  );

  let sent: { message: SentMessage; notify: boolean };
  try {
    sent = await bound(actor, (db) => sendInTransaction(db, actor, conversationId, text, key));
  } catch (err) {
    // Two retries of one send both cleared the replay check, and one lost the
    // unique index. Its transaction is aborted, so the winner is read in a
    // new one: the message WAS delivered, and saying so is the right answer.
    if (key && isUniqueViolation(err)) {
      const prior = await bound(actor, (db) =>
        db.chatMessage.findFirst({
          where: { senderId: actor.userId, clientMutationId: key },
          select: { id: true, createdAt: true },
        }),
      );
      if (prior) return { id: prior.id, createdAt: prior.createdAt, replayed: true };
    }
    throw err;
  }

  // After the commit, never inside it (agri-saas #1203). Never throws.
  if (sent.notify) {
    await notifyNewMessage({ conversationId, messageId: sent.message.id, sender: actor });
  }
  return sent.message;
}

async function sendInTransaction(
  db: PrismaClient,
  actor: MessagingActor,
  conversationId: string,
  text: string,
  key: string | null,
): Promise<{ message: SentMessage; notify: boolean }> {
  if (key) {
    const prior = await db.chatMessage.findFirst({
      where: { senderId: actor.userId, clientMutationId: key },
      select: { id: true, createdAt: true },
    });
    if (prior)
      return {
        message: { id: prior.id, createdAt: prior.createdAt, replayed: true },
        notify: false,
      };
  }

  const c = await requireConversation(db, actor, conversationId);
  const other = otherPersonOf(c, actor);

  // The other person deleted their account: nobody is there to read it.
  if (other) {
    const gone = await db.user.findFirst({
      where: { id: other, deletedAt: { not: null } },
      select: { id: true },
    });
    if (gone) {
      throw new MessagingError('RECIPIENT_GONE', 409, 'This person is no longer on playerz.');
    }
  }

  // A club conversation blocked by a side, or any conversation a moderator
  // closed (P55). A DM's person block is checked below.
  if (c.blockedAt) {
    throw new MessagingError('CONVERSATION_BLOCKED', 403, 'This conversation is blocked.');
  }

  let accept = false;
  if (c.type === 'DM') {
    // Mutual silence: either direction stops new messages. Only the BLOCKER
    // reaches this — the blocked person was answered 404 above, because the
    // conversation is hidden from them — so the refusal may say what it is.
    if (other) {
      const block = await db.userBlock.findFirst({
        where: { blockerId: actor.userId, blockedId: other },
        select: { blockerId: true },
      });
      if (block) {
        throw new MessagingError(
          'CONVERSATION_BLOCKED',
          403,
          'You have blocked this person. Unblock them to write again.',
        );
      }
    }
    if (!c.acceptedAt) {
      if (c.createdById === actor.userId) {
        // A request: one message, then wait. A decline is quiet, so it reads
        // to the sender exactly like waiting.
        const already = await db.chatMessage.count({
          where: { conversationId, senderId: actor.userId },
        });
        if (already > 0 || c.declinedAt) {
          throw new MessagingError(
            'REQUEST_PENDING',
            409,
            'Your request is waiting. You can write again once it is accepted.',
          );
        }
      } else {
        // Answering a request accepts it — even one declined earlier.
        accept = true;
      }
    }
  }

  const now = new Date();
  const row = await db.chatMessage.create({
    data: {
      conversationId,
      senderId: actor.userId,
      senderTenantId: actor.kind === 'club' ? actor.tenantId : null,
      body: encryptField(text),
      clientMutationId: key,
      createdAt: now,
    },
    select: { id: true, createdAt: true },
  });
  // Same transaction as the insert, so a conversation never sorts by a
  // message that does not exist.
  await db.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now, ...(accept ? { acceptedAt: now, declinedAt: null } : {}) },
  });
  // The sender has read their own message: without this, sending bumps
  // `lastMessageAt` past the sender's own pointer.
  await markReadFor(db, actor, conversationId, now);

  return { message: { id: row.id, createdAt: row.createdAt, replayed: false }, notify: true };
}

/** Retract a message: a tombstone in its place, its body gone. Only your own. */
export async function retractMessage(
  actor: MessagingActor,
  messageId: string,
): Promise<{ id: string }> {
  return bound(actor, async (db) => {
    const m = await db.chatMessage.findFirst({
      where: { id: messageId },
      select: { id: true, senderId: true, conversationId: true, deletedAt: true },
    });
    if (!m) throw new MessagingError('MESSAGE_NOT_FOUND', 404, 'That message was not found.');
    // Through the same door as every read: a staff member of another club, or
    // a blocked person, gets the same 404.
    await requireConversation(db, actor, m.conversationId);
    // The PERSON, not the side: a colleague's reply is not yours to unsay.
    if (m.senderId !== actor.userId) {
      throw new MessagingError('MESSAGE_NOT_SENDER', 403, 'You can only remove your own messages.');
    }
    if (m.deletedAt) return { id: m.id };
    await db.chatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), body: '' },
    });
    return { id: m.id };
  });
}

// ─── Requests ───────────────────────────────────────────────────────────

async function requireIncomingRequest(
  db: PrismaClient,
  actor: Extract<MessagingActor, { kind: 'player' }>,
  conversationId: string,
): Promise<ConversationRow> {
  const c = await requireConversation(db, actor, conversationId);
  if (c.type !== 'DM' || c.createdById === actor.userId) {
    throw new MessagingError('NOT_A_REQUEST', 409, 'That conversation is not a request to you.');
  }
  return c;
}

/** Accept a request: from now on both may write. Idempotent. */
export async function acceptRequest(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  conversationId: string,
): Promise<{ acceptedAt: Date }> {
  return bound(actor, async (db) => {
    const c = await requireIncomingRequest(db, actor, conversationId);
    if (c.acceptedAt) return { acceptedAt: c.acceptedAt };
    const now = new Date();
    await db.conversation.update({
      where: { id: conversationId },
      data: { acceptedAt: now, declinedAt: null },
    });
    await markReadFor(db, actor, conversationId, now);
    return { acceptedAt: now };
  });
}

/**
 * Decline a request. QUIET: it leaves the recipient's «Заявки», the sender is
 * told nothing, and their one message stays their only one. Idempotent. An
 * accepted conversation cannot be declined; that is what block is for.
 */
export async function declineRequest(
  actor: Extract<MessagingActor, { kind: 'player' }>,
  conversationId: string,
): Promise<{ declinedAt: Date }> {
  return bound(actor, async (db) => {
    const c = await requireIncomingRequest(db, actor, conversationId);
    if (c.acceptedAt) {
      throw new MessagingError('NOT_A_REQUEST', 409, 'That conversation is not a request to you.');
    }
    if (c.declinedAt) return { declinedAt: c.declinedAt };
    const now = new Date();
    await db.conversation.update({ where: { id: conversationId }, data: { declinedAt: now } });
    await markReadFor(db, actor, conversationId, now);
    return { declinedAt: now };
  });
}

// ─── Report ─────────────────────────────────────────────────────────────

export { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason };

export interface ReportInput {
  reason: ReportReason;
  details?: string | null;
}

/** `spam`, or `abuse — what they said`: one line for the moderator, the category first. */
function reportReason(input: ReportInput): string {
  const details = sanitizePlainText(input.details ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REPORT_DETAILS_MAX);
  return details ? `${input.reason} — ${details}` : input.reason;
}

/**
 * Report a message to the platform's moderators (#375): it joins the queue
 * reviews already go to (REVIEW_MODERATE), one case per message however many
 * people report it. Only somebody who can read the message may report it, and
 * never their own (nor, for a club, the club's own reply). The other side is
 * not told.
 */
export async function reportMessage(
  actor: MessagingActor,
  messageId: string,
  input: ReportInput,
): Promise<{ reported: true }> {
  await bound(actor, async (db) => {
    const m = await db.chatMessage.findFirst({
      where: { id: messageId },
      select: { conversationId: true, senderId: true, senderTenantId: true },
    });
    if (!m) throw new MessagingError('MESSAGE_NOT_FOUND', 404, 'That message was not found.');
    await requireConversation(db, actor, m.conversationId);
    const own =
      m.senderId === actor.userId || (actor.kind === 'club' && m.senderTenantId === actor.tenantId);
    if (own) {
      throw new MessagingError('REPORT_OWN_MESSAGE', 400, 'You cannot report your own message.');
    }
  });
  await fileChatReport({
    subjectType: 'CHAT_MESSAGE',
    subjectId: messageId,
    reporterUserId: actor.userId,
    reason: reportReason(input),
  });
  return { reported: true };
}

/** Report a whole conversation (#375), as `reportMessage`. */
export async function reportConversation(
  actor: MessagingActor,
  conversationId: string,
  input: ReportInput,
): Promise<{ reported: true }> {
  await bound(actor, (db) => requireConversation(db, actor, conversationId));
  await fileChatReport({
    subjectType: 'CONVERSATION',
    subjectId: conversationId,
    reporterUserId: actor.userId,
    reason: reportReason(input),
  });
  return { reported: true };
}

// ─── Block ──────────────────────────────────────────────────────────────

/**
 * Block the other side of a conversation: no new messages either way
 * (agri-saas P5.2b). Addressed by CONVERSATION, so the API never takes a
 * person's id to block and the caller provably has standing.
 *
 *   DM    a person block (`UserBlock`), which follows the person everywhere:
 *         the other player loses sight of the conversation and of the caller
 *         in search, silently; the caller keeps the history.
 *   CLUB  the conversation is blocked by the caller's SIDE. Only that side
 *         lifts it. Both still see the conversation, and neither may write.
 *
 * Idempotent: blocking twice is one block.
 */
export async function blockConversation(
  actor: MessagingActor,
  conversationId: string,
): Promise<{ blocked: true }> {
  return bound(actor, async (db) => {
    const c = await requireConversation(db, actor, conversationId);
    if (c.type === 'DM') {
      const other = otherPersonOf(c, actor);
      if (!other) throw notFound();
      await db.userBlock.createMany({
        data: [{ blockerId: actor.userId, blockedId: other }],
        // ON CONFLICT DO NOTHING: a unique violation would abort the
        // transaction, and blocking twice is not an error.
        skipDuplicates: true,
      });
      return { blocked: true };
    }
    if (!c.blockedAt) {
      await db.conversation.update({
        where: { id: conversationId },
        data: {
          blockedAt: new Date(),
          blockedSide: actor.kind === 'club' ? 'CLUB' : 'PLAYER',
          blockedByUserId: actor.userId,
        },
      });
    }
    return { blocked: true };
  });
}

/** Lift a block the caller's side placed. Absent is the goal, so a missing block is not an error. */
export async function unblockConversation(
  actor: MessagingActor,
  conversationId: string,
): Promise<{ blocked: false }> {
  return bound(actor, async (db) => {
    const c = await requireConversation(db, actor, conversationId);
    if (c.type === 'DM') {
      const other = otherPersonOf(c, actor);
      if (other) {
        await db.userBlock.deleteMany({ where: { blockerId: actor.userId, blockedId: other } });
      }
      return { blocked: false };
    }
    const mySide = actor.kind === 'club' ? 'CLUB' : 'PLAYER';
    if (c.blockedAt && c.blockedSide !== mySide) {
      throw new MessagingError(
        'BLOCKED_BY_OTHER_SIDE',
        403,
        'Only the side that blocked this conversation can lift the block.',
      );
    }
    if (c.blockedAt) {
      await db.conversation.update({
        where: { id: conversationId },
        data: { blockedAt: null, blockedSide: null, blockedByUserId: null },
      });
    }
    return { blocked: false };
  });
}
