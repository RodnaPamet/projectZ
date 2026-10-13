import { randomInt } from 'node:crypto';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * The game chat (#376, owner decision 2026-10-13, rule 3): a group chat of the
 * booker and everyone accepted into their open game.
 *
 *   - Made when the booker accepts the FIRST player, not when the game opens:
 *     a chat of one, for a game nobody may ever join, would sit in the
 *     booker's «Съобщения» saying nothing.
 *   - Accepting adds the player. Leaving the game, or being taken off it, before
 *     it is played takes them out (`leftAt`; the row stays, so their messages
 *     keep their name in the others' history).
 *   - It stays open after the game, as an ordinary group chat. Nothing here
 *     closes it, a cancelled booking included: the people in it may well want
 *     to find another court.
 *
 * ═══ THE ROSTER, NOT EVENTS ═══
 *
 * `syncGameChat` makes the chat's members equal the game's roster (the booker
 * and every ACCEPTED request), whatever the event that called it. Run after
 * the commit that changed the roster, it cannot undo that change, and if it
 * fails the next change puts the chat right. Idempotent: a repeated call
 * changes nothing.
 *
 * ═══ WHY THE SUPERUSER BINDING ═══
 *
 * The chat has no club (`tenantId` NULL, like a DM: the club never reads it),
 * and its members are decided by the game, not by any one of them. P54's
 * policies let app_user create only DM and CLUB conversations and seed only
 * their own kind of members, and P63's trigger stops a member changing their
 * own membership. So the roster is written here, by the server, from rows the
 * tenant-bound transaction already decided; nobody's request can name who is
 * added.
 */

/** The chat's pair key: one chat per game, whoever races to make it. */
export function gameChatKey(gameId: string): string {
  return `game:${gameId}`;
}

function newConversationId(): string {
  let out = 'c';
  for (let i = 0; i < 24; i++) out += randomInt(36).toString(36);
  return out;
}

/**
 * Make the game chat's members the game's roster. Returns the chat's id, or
 * null when there is none yet (nobody accepted). Never throws: a chat that
 * could not be synced is logged, and the next roster change syncs it.
 */
export async function syncGameChat(tenantId: string, gameId: string): Promise<string | null> {
  try {
    return await sync(tenantId, gameId);
  } catch (err) {
    logger.warn('game chat not synced', {
      component: 'open-play',
      gameId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The same, for the game on a booking, if it has one. Never throws. */
export async function syncGameChatOfBooking(tenantId: string, bookingId: string): Promise<void> {
  try {
    // guardrail-allow: cross-tenant — one booking's game, by the ids of a
    // change that just committed in that club.
    const game = await runAsSuperuser((db) =>
      db.openGame.findFirst({ where: { tenantId, bookingId }, select: { id: true } }),
    );
    if (game) await syncGameChat(tenantId, game.id);
  } catch (err) {
    logger.warn('game chat not synced', {
      component: 'open-play',
      bookingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sync(tenantId: string, gameId: string): Promise<string | null> {
  // guardrail-allow: cross-tenant — the game chat has no club; its roster is
  // the game's, read by the game's own ids.
  return runAsSuperuser(async (db) => {
    const game = await db.openGame.findFirst({
      where: { id: gameId, tenantId },
      select: {
        conversationId: true,
        booking: { select: { bookedByUserId: true } },
        requests: { where: { status: 'ACCEPTED' }, select: { userId: true }, take: 64 },
      },
    });
    const booker = game?.booking.bookedByUserId;
    if (!game || !booker) return null;
    const roster = new Set([booker, ...game.requests.map((r) => r.userId)]);

    let conversationId = game.conversationId;
    if (!conversationId) {
      if (roster.size < 2) return null;
      const key = gameChatKey(gameId);
      const id = newConversationId();
      const now = new Date();
      // `createMany` with `skipDuplicates` on the unique pair key: two accepts
      // racing make ONE chat, and both find it below.
      await db.conversation.createMany({
        data: [
          {
            id,
            type: 'GROUP',
            tenantId: null,
            pairKey: key,
            createdById: booker,
            acceptedAt: now,
            lastMessageAt: now,
          },
        ],
        skipDuplicates: true,
      });
      const chat = await db.conversation.findFirst({
        where: { pairKey: key },
        select: { id: true },
      });
      if (!chat) return null;
      conversationId = chat.id;
      await db.openGame.updateMany({
        where: { id: gameId, tenantId, conversationId: null },
        data: { conversationId },
      });
    }

    const rows = await db.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true, leftAt: true },
      take: 128,
    });
    const present = new Map(rows.map((r) => [r.userId, r.leftAt]));
    const now = new Date();

    const joining = [...roster].filter((u) => !present.has(u));
    if (joining.length > 0) {
      await db.conversationParticipant.createMany({
        data: joining.map((userId) => ({
          conversationId: conversationId!,
          userId,
          role: 'MEMBER',
        })),
        skipDuplicates: true,
      });
    }
    const back = [...roster].filter((u) => present.has(u) && present.get(u) !== null);
    if (back.length > 0) {
      await db.conversationParticipant.updateMany({
        where: { conversationId, userId: { in: back } },
        data: { leftAt: null },
      });
    }
    const gone = rows
      .filter((r) => r.leftAt === null && !roster.has(r.userId))
      .map((r) => r.userId);
    if (gone.length > 0) {
      await db.conversationParticipant.updateMany({
        where: { conversationId, userId: { in: gone }, leftAt: null },
        data: { leftAt: now },
      });
    }
    return conversationId;
  });
}
