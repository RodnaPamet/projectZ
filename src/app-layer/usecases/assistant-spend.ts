import { formatInTimeZone } from 'date-fns-tz';

import { dailySpendCapMicros } from '@/app-layer/ai/assistant/config';
import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * The daily spend cap per player (owner 2026-11-14, #704): agri-saas's
 * `AI_BUDGET_EXCEEDED` / `ASSISTANT_SPEND_CEILING`, per PERSON per DAY
 * rather than per farm per month, because a player is one person and the
 * assistant is free to them.
 *
 * Checked before every model call, so a question that crosses the line
 * mid-answer still ends with what it gathered and a halt saying why; and
 * charged after every call from the usage the API reports, at list price.
 * The memory sweep charges the same row.
 */

/** The Sofia calendar day of `now`, as the DATE column stores it (midnight UTC). */
export function spendDay(now: Date): Date {
  return new Date(`${formatInTimeZone(now, 'Europe/Sofia', 'yyyy-MM-dd')}T00:00:00.000Z`);
}

export class AssistantSpendCeilingError extends Error {
  constructor() {
    super('The daily assistant limit is reached.');
    this.name = 'AssistantSpendCeilingError';
  }
}

export async function spentToday(userId: string, now: Date = new Date()): Promise<number> {
  const row = await runAsUserOnly(userId, (db) =>
    db.assistantSpend.findUnique({
      where: { userId_day: { userId, day: spendDay(now) } },
      select: { costMicros: true },
    }),
  );
  return row?.costMicros ?? 0;
}

/** Throws `AssistantSpendCeilingError` once today's spend has reached the cap. */
export async function assertWithinSpendCap(userId: string, now: Date = new Date()): Promise<void> {
  if ((await spentToday(userId, now)) >= dailySpendCapMicros()) {
    throw new AssistantSpendCeilingError();
  }
}

/** Adds one call's cost to today's row. Atomic: two answers at once both count. */
export async function recordSpend(
  userId: string,
  micros: number,
  now: Date = new Date(),
): Promise<void> {
  const cost = Math.max(0, Math.ceil(micros));
  await runAsUserOnly(userId, (db) =>
    db.assistantSpend.upsert({
      where: { userId_day: { userId, day: spendDay(now) } },
      create: { userId, day: spendDay(now), costMicros: cost, calls: 1 },
      update: { costMicros: { increment: cost }, calls: { increment: 1 } },
    }),
  );
}
