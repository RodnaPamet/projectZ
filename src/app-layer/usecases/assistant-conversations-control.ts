import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * The person's past conversations (agri-saas #2695): the list, one
 * conversation's turns, delete one or all, and the recall search the
 * assistant uses. All as the person; a deleted conversation is gone from every
 * one of these and from the window.
 */

export const CONVERSATION_LIST_LIMIT = 50;
export const CONVERSATION_DETAIL_TURN_CAP = 200;

export const RECALL_CONVERSATION_CAP = 40;
export const RECALL_TURN_SCAN_CAP = 300;
export const RECALL_MAX_EXCERPTS = 8;
export const RECALL_EXCERPT_CHARS = 400;

export class AssistantConversationNotFoundError extends Error {
  constructor() {
    super('That conversation was not found.');
    this.name = 'AssistantConversationNotFoundError';
  }
}

export interface PastConversation {
  id: string;
  startedAt: string;
  lastTurnAt: string;
  turns: number;
  /** The person's first question, for the row's title. */
  opening: string | null;
}

export async function listPastConversations(userId: string): Promise<PastConversation[]> {
  const rows = await runAsUserOnly(userId, (db) =>
    db.assistantConversation.findMany({
      where: { userId, deletedAt: null, turns: { some: {} } },
      orderBy: { lastTurnAt: 'desc' },
      take: CONVERSATION_LIST_LIMIT,
      select: {
        id: true,
        startedAt: true,
        lastTurnAt: true,
        _count: { select: { turns: true } },
        turns: {
          where: { role: 'user' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { content: true },
        },
      },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    lastTurnAt: r.lastTurnAt.toISOString(),
    turns: r._count.turns,
    opening: r.turns[0]?.content ?? null,
  }));
}

export interface PastConversationDetail {
  id: string;
  startedAt: string;
  lastTurnAt: string;
  turns: number;
  items: Array<{ role: 'user' | 'assistant'; text: string; at: string }>;
  /** More turns than `CONVERSATION_DETAIL_TURN_CAP`: the oldest are not shown. */
  truncated: boolean;
}

export async function getPastConversation(
  userId: string,
  id: string,
): Promise<PastConversationDetail> {
  const row = await runAsUserOnly(userId, (db) =>
    db.assistantConversation.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        startedAt: true,
        lastTurnAt: true,
        _count: { select: { turns: true } },
        turns: {
          orderBy: { createdAt: 'desc' },
          take: CONVERSATION_DETAIL_TURN_CAP,
          select: { role: true, content: true, createdAt: true },
        },
      },
    }),
  );
  if (!row) throw new AssistantConversationNotFoundError();
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    lastTurnAt: row.lastTurnAt.toISOString(),
    turns: row._count.turns,
    items: row.turns
      .slice()
      .reverse()
      .map((t) => ({
        role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        text: t.content,
        at: t.createdAt.toISOString(),
      })),
    truncated: row._count.turns > row.turns.length,
  };
}

/** Tombstoned, not removed: a stale id then starts a fresh conversation. */
export async function deletePastConversation(userId: string, id: string): Promise<void> {
  const { count } = await runAsUserOnly(userId, (db) =>
    db.assistantConversation.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    }),
  );
  if (count === 0) throw new AssistantConversationNotFoundError();
}

export async function deleteAllPastConversations(userId: string): Promise<number> {
  const { count } = await runAsUserOnly(userId, (db) =>
    db.assistantConversation.updateMany({
      where: { userId, deletedAt: null },
      data: { deletedAt: new Date() },
    }),
  );
  return count;
}

export interface RecallExcerpt {
  conversationId: string;
  on: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Find earlier exchanges that mention `query` (a substring, case-insensitive),
 * newest first, bounded: an empty result means this search found nothing,
 * not that it was never said.
 */
export async function searchPastConversations(
  userId: string,
  opts: { query: string; from?: string; to?: string },
): Promise<RecallExcerpt[]> {
  const needle = opts.query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const from = opts.from ? new Date(opts.from) : null;
  const to = opts.to ? new Date(`${opts.to.slice(0, 10)}T23:59:59.999Z`) : null;
  const valid = (d: Date | null) => d === null || !Number.isNaN(d.getTime());
  if (!valid(from) || !valid(to)) return [];

  const conversations = await runAsUserOnly(userId, (db) =>
    db.assistantConversation.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(from || to
          ? { lastTurnAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: { lastTurnAt: 'desc' },
      take: RECALL_CONVERSATION_CAP,
      select: {
        id: true,
        turns: {
          orderBy: { createdAt: 'desc' },
          take: 60,
          select: { role: true, content: true, createdAt: true },
        },
      },
    }),
  );

  const out: RecallExcerpt[] = [];
  let scanned = 0;
  for (const c of conversations) {
    for (const t of c.turns) {
      if (scanned >= RECALL_TURN_SCAN_CAP || out.length >= RECALL_MAX_EXCERPTS) return out;
      scanned += 1;
      if (!t.content.toLowerCase().includes(needle)) continue;
      out.push({
        conversationId: c.id,
        on: t.createdAt.toISOString().slice(0, 10),
        role: t.role === 'assistant' ? 'assistant' : 'user',
        text: t.content.slice(0, RECALL_EXCERPT_CHARS),
      });
    }
  }
  return out;
}
