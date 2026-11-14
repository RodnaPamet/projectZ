import { Prisma } from '@prisma/client';

import { completeWithClaude, costMicros, type CompleteFn } from '@/app-layer/ai/anthropic';
import { assistantMemoryEnabled, memoryModel } from '@/app-layer/ai/assistant/config';
import { extractMemoryPoints } from '@/app-layer/ai/assistant/memory-extractor';
import { REMEMBERED_POINT_LIMIT } from '@/lib/assistant/memory-limits';
import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { AssistantSpendCeilingError, assertWithinSpendCap, recordSpend } from './assistant-spend';

/**
 * The memory sweep (agri-saas `jobs/memory-extract.ts`): every few minutes,
 * the conversations that went quiet with questions not read yet; their new
 * questions go through the extractor and the points it accepts are written.
 *
 * The one cross-person read is the list of due conversations (ids and times,
 * as app_superuser, a timer with no session). Everything after it runs as
 * the person, through owner-only RLS.
 */

/** A conversation is read once it has been quiet this long. */
export const IDLE_MS = 10 * 60_000;
export const SWEEP_BATCH = 20;
/** The newest questions read per conversation. */
export const MAX_TURNS_READ = 20;

export async function runMemorySweep(
  opts: { now?: Date; complete?: CompleteFn } = {},
): Promise<{ read: number; learned: number; skipped: number }> {
  const result = { read: 0, learned: 0, skipped: 0 };
  if (!assistantMemoryEnabled()) return result;
  const now = opts.now ?? new Date();
  const complete = opts.complete ?? ((req) => completeWithClaude(req));
  const idleBefore = new Date(now.getTime() - IDLE_MS);

  // guardrail-allow: cross-tenant — the sweep's queue: ids and times only.
  const due = await runAsSuperuser((db) =>
    db.$queryRaw<Array<{ id: string; userId: string; extractedAt: Date | null }>>(Prisma.sql`
      SELECT "id", "userId", "extractedAt" FROM "assistant_conversation"
       WHERE "deletedAt" IS NULL
         AND "lastTurnAt" < ${idleBefore}
         AND ("extractedAt" IS NULL OR "extractedAt" < "lastTurnAt")
       ORDER BY "lastTurnAt" ASC
       LIMIT ${SWEEP_BATCH}`),
  );

  for (const c of due) {
    try {
      // guardrail-allow: n-plus-one — one extraction per conversation, by design.
      const learned = await sweepOne(c, now, complete);
      result.read += 1;
      result.learned += learned;
    } catch (err) {
      result.skipped += 1;
      if (!(err instanceof AssistantSpendCeilingError)) {
        logger.warn('assistant.memory_sweep_failed', {
          component: 'assistant',
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  }
  return result;
}

async function sweepOne(
  c: { id: string; userId: string; extractedAt: Date | null },
  now: Date,
  complete: CompleteFn,
): Promise<number> {
  const { userId } = c;
  const [turns, existing] = await runAsUserOnly(userId, (db) =>
    Promise.all([
      db.assistantTurn.findMany({
        where: {
          conversationId: c.id,
          userId,
          role: 'user',
          ...(c.extractedAt ? { createdAt: { gt: c.extractedAt } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_TURNS_READ,
        select: { content: true, createdAt: true },
      }),
      db.assistantMemoryFact.findMany({
        where: { userId, supersededAt: null },
        select: { id: true, text: true, editedByPerson: true, deletedAt: true, sourceQuote: true },
        orderBy: { sourceAt: 'desc' },
        take: REMEMBERED_POINT_LIMIT * 2,
      }),
    ]),
  );

  let learned = 0;
  if (turns.length > 0) {
    await assertWithinSpendCap(userId, now);
    const { candidates, usage } = await extractMemoryPoints(
      complete,
      memoryModel(),
      turns.reverse(),
      existing.map((p) => ({
        id: p.id,
        text: p.text,
        editedByPerson: p.editedByPerson,
        refused: p.deletedAt !== null,
        sourceQuote: p.sourceQuote,
      })),
    );
    if (usage) await recordSpend(userId, costMicros(usage.model, usage.usage), now);

    learned = await runAsUserOnly(userId, async (db) => {
      let live = existing.filter((p) => p.deletedAt === null).length;
      let n = 0;
      for (const cand of candidates) {
        if (cand.supersedesId) {
          const { count } = await db.assistantMemoryFact.updateMany({
            where: {
              id: cand.supersedesId,
              userId,
              deletedAt: null,
              supersededAt: null,
              editedByPerson: false,
            },
            data: { supersededAt: now },
          });
          live -= count;
        }
        // Rule 8: past the bound the sweep is accumulating, not superseding.
        if (live >= REMEMBERED_POINT_LIMIT) break;
        await db.assistantMemoryFact.create({
          data: { userId, text: cand.text, sourceQuote: cand.sourceQuote, sourceAt: cand.sourceAt },
        });
        live += 1;
        n += 1;
      }
      return n;
    });
  }

  await runAsUserOnly(userId, (db) =>
    db.assistantConversation.updateMany({
      where: { id: c.id, userId },
      data: { extractedAt: now },
    }),
  );
  return learned;
}
