import { Prisma, type ModerationCaseStatus, type PrismaClient } from '@prisma/client';

import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';

import { CaseAlreadyResolvedError, ModerationCaseNotFoundError } from './reviews';

/**
 * Reported messages and conversations in the platform moderation queue (#375).
 *
 * The queue reviews already go to: one OPEN case per subject however many
 * people report it (`reportContent`), worked by a holder of REVIEW_MODERATE
 * through `asPlatformAdmin`, which writes the audit row. So the handle here is
 * that audited platform binding, across every club and every person.
 *
 * ═══ WHAT A MODERATOR SEES ═══
 *
 * The reported message, its conversation's latest messages around it (who
 * wrote each line — a club's reply with the club — and the text, decrypted as
 * the people in the conversation read it), and what the reports said:
 * category and words, never who reported. Whether a line is abuse does not
 * depend on who flagged it, and naming the reporter to the moderator is one
 * screenshot away from naming them to the reported.
 *
 * ═══ WHAT A DECISION DOES ═══
 *
 *   keep (APPROVE)     nothing; the case is closed
 *   remove (REJECT)    a message: its text is gone, a tombstone keeps its place,
 *                      as a retraction does; a conversation: closed for both
 *                      sides (`blockedSide` PLATFORM), and nobody in it can
 *                      lift that
 */

/** The latest messages of a conversation a case shows around what was reported. */
export const CASE_CONTEXT_MESSAGES = 20;

export interface CaseMessage {
  id: string;
  from: { name: string | null; deleted: boolean; clubName: string | null };
  body: string | null;
  deleted: boolean;
  createdAt: Date;
  /** The message this case is about. */
  reported: boolean;
}

export interface ChatQueueItem {
  subject: 'CHAT_MESSAGE' | 'CONVERSATION';
  caseId: string;
  reason: string;
  openedAt: Date;
  conversation: {
    id: string;
    kind: 'player' | 'club';
    club: { name: string } | null;
    /** A moderator already closed it. */
    closed: boolean;
  };
  /** Latest first is the database's order; this is oldest first, as it is read. */
  messages: CaseMessage[];
  /** What the reports said: category, and the reporter's words. Never who. */
  reports: Array<{ reason: string; at: Date }>;
}

function open(body: string): string | null {
  if (!body) return null;
  try {
    return decryptField(body);
  } catch (err) {
    logger.warn('reported message body did not decrypt', {
      component: 'moderation',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The chat cases among `cases` (one page of the queue, in its order), each with
 * its conversation's context. Six reads for the whole page, never one per
 * case. A case whose subject is gone — a conversation deleted with its people,
 * a message id that names nothing — has nothing to decide and is left out.
 */
export async function chatCaseItems(
  db: PrismaClient,
  cases: ReadonlyArray<{
    id: string;
    subjectType: string;
    subjectId: string;
    reason: string;
    createdAt: Date;
  }>,
): Promise<Map<string, ChatQueueItem>> {
  const out = new Map<string, ChatQueueItem>();
  const chat = cases.filter(
    (c) => c.subjectType === 'CHAT_MESSAGE' || c.subjectType === 'CONVERSATION',
  );
  if (chat.length === 0) return out;

  const messageIds = chat.filter((c) => c.subjectType === 'CHAT_MESSAGE').map((c) => c.subjectId);
  // guardrail-allow: cross-tenant — the reported messages, by id, for the
  // audited platform queue.
  const reported = messageIds.length
    ? await db.chatMessage.findMany({
        where: { id: { in: messageIds } },
        select: { id: true, conversationId: true },
        take: messageIds.length,
      })
    : [];
  const conversationOf = new Map(reported.map((m) => [m.id, m.conversationId]));
  const conversationIds = [
    ...new Set([
      ...chat.filter((c) => c.subjectType === 'CONVERSATION').map((c) => c.subjectId),
      ...reported.map((m) => m.conversationId),
    ]),
  ];
  if (conversationIds.length === 0) return out;

  const [conversations, context, reports] = await Promise.all([
    // guardrail-allow: cross-tenant — the conversations the page's cases name.
    db.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: { id: true, type: true, tenantId: true, blockedSide: true },
      take: conversationIds.length,
    }),
    db.$queryRaw<
      Array<{
        id: string;
        conversationId: string;
        senderId: string;
        senderTenantId: string | null;
        body: string;
        deletedAt: Date | null;
        createdAt: Date;
      }>
    >`
      SELECT "id", "conversationId", "senderId", "senderTenantId", "body", "deletedAt", "createdAt"
        FROM (
          SELECT m.*, row_number() OVER (
                   PARTITION BY m."conversationId" ORDER BY m."createdAt" DESC, m."id" DESC) AS rn
            FROM "chat_message" m
           WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
        ) recent
       WHERE rn <= ${CASE_CONTEXT_MESSAGES}
          OR "id" IN (${Prisma.join(messageIds.length ? messageIds : [''])})
       ORDER BY "createdAt" ASC, "id" ASC`,
    // guardrail-allow: cross-tenant — what the reports on these subjects said.
    db.contentReport.findMany({
      where: { subjectId: { in: chat.map((c) => c.subjectId) } },
      select: { subjectType: true, subjectId: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: chat.length * 50,
    }),
  ]);

  const senderIds = [...new Set(context.map((m) => m.senderId))];
  const tenantIds = [
    ...new Set([
      ...conversations.flatMap((c) => (c.tenantId ? [c.tenantId] : [])),
      ...context.flatMap((m) => (m.senderTenantId ? [m.senderTenantId] : [])),
    ]),
  ];
  const [users, clubs] = await Promise.all([
    senderIds.length
      ? db.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, name: true, deletedAt: true },
          take: senderIds.length,
        })
      : Promise.resolve([]),
    tenantIds.length
      ? db.venueOrg.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true },
          take: tenantIds.length,
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const convById = new Map(conversations.map((c) => [c.id, c]));

  for (const c of chat) {
    const conversationId =
      c.subjectType === 'CONVERSATION' ? c.subjectId : conversationOf.get(c.subjectId);
    const conv = conversationId ? convById.get(conversationId) : undefined;
    if (!conv) continue;
    out.set(c.id, {
      subject: c.subjectType as ChatQueueItem['subject'],
      caseId: c.id,
      reason: c.reason,
      openedAt: c.createdAt,
      conversation: {
        id: conv.id,
        kind: conv.type === 'CLUB' ? 'club' : 'player',
        club: conv.tenantId ? { name: clubName.get(conv.tenantId) ?? '' } : null,
        closed: conv.blockedSide === 'PLATFORM',
      },
      messages: context
        .filter((m) => m.conversationId === conv.id)
        .map((m) => {
          const u = userById.get(m.senderId);
          return {
            id: m.id,
            from: {
              name: u && !u.deletedAt ? u.name : null,
              deleted: !u || u.deletedAt !== null,
              clubName: m.senderTenantId ? (clubName.get(m.senderTenantId) ?? null) : null,
            },
            body: m.deletedAt ? null : open(m.body),
            deleted: m.deletedAt !== null,
            createdAt: m.createdAt,
            reported: c.subjectType === 'CHAT_MESSAGE' && m.id === c.subjectId,
          };
        }),
      reports: reports
        .filter((r) => r.subjectId === c.subjectId && r.subjectType === c.subjectType)
        .map((r) => ({ reason: r.reason, at: r.createdAt })),
    });
  }
  return out;
}

export interface ChatCaseResolution {
  caseId: string;
  status: ModerationCaseStatus;
  /** What the decision removed: the message, the conversation (closed), or nothing. */
  removed: 'message' | 'conversation' | null;
}

/**
 * A moderator decides a reported message or conversation. Closed by an UPDATE
 * that only matches an OPEN case about a message or a conversation, so two
 * moderators deciding at once cannot both win, and this route cannot decide a
 * review (whose decision moves a venue's rating; that is `resolveCase`).
 */
export async function resolveChatCase(
  db: PrismaClient,
  input: { caseId: string; moderatorUserId: string; approve: boolean; note?: string },
): Promise<ChatCaseResolution> {
  return db.$transaction(async (tx) => {
    // guardrail-allow: cross-tenant — one case by id, from the audited platform route.
    const [closed] = await tx.moderationCase.updateManyAndReturn({
      where: {
        id: input.caseId,
        status: 'OPEN',
        subjectType: { in: ['CHAT_MESSAGE', 'CONVERSATION'] },
      },
      data: {
        status: input.approve ? 'APPROVED' : 'REJECTED',
        resolvedByUserId: input.moderatorUserId,
        resolvedAt: new Date(),
        resolutionNote: input.note ?? null,
      },
      select: { id: true, subjectType: true, subjectId: true, status: true },
    });
    if (!closed) {
      // guardrail-allow: cross-tenant — only to say WHICH refusal it is.
      const exists = await tx.moderationCase.count({
        where: { id: input.caseId, subjectType: { in: ['CHAT_MESSAGE', 'CONVERSATION'] } },
      });
      throw exists > 0 ? new CaseAlreadyResolvedError() : new ModerationCaseNotFoundError();
    }
    if (input.approve) return { caseId: closed.id, status: closed.status, removed: null };

    const now = new Date();
    if (closed.subjectType === 'CHAT_MESSAGE') {
      // guardrail-allow: cross-tenant — the one reported message, by id.
      await tx.chatMessage.updateMany({
        where: { id: closed.subjectId },
        data: { deletedAt: now, body: '' },
      });
      return { caseId: closed.id, status: closed.status, removed: 'message' };
    }
    // guardrail-allow: cross-tenant — the one reported conversation, by id.
    await tx.conversation.updateMany({
      where: { id: closed.subjectId },
      data: { blockedAt: now, blockedSide: 'PLATFORM', blockedByUserId: input.moderatorUserId },
    });
    return { caseId: closed.id, status: closed.status, removed: 'conversation' };
  });
}
