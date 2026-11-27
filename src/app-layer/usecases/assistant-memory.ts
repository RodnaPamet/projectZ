import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { REMEMBERED_POINT_LIMIT, REMEMBERED_POINT_MAX_CHARS } from '@/lib/assistant/memory-limits';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * «Какво помни асистентът» — the person's view of their profile (agri-saas
 * #2686), and the rules it holds (docs/assistant.md, "The memory rules"):
 *
 *   - Rule 5, deleted is deleted: «Изтрий» and «Забрави всичко» remove the
 *     rows at once and for good (owner 2026-11-15, #716). Nothing of the
 *     deleted text is kept, so there is no "never re-learn" list: if the
 *     person says it again, the sweep may learn it again.
 *   - Rule 6, an edited point is theirs: an edit sets `editedByPerson`, and
 *     the sweep never rewrites or supersedes such a point.
 *   - Rule 4, latest wins: an edit re-dates the evidence (`sourceAt`), or the
 *     correction would read as older than what it corrected.
 *   - Rule 7, the evidence stays on the server: the list returns neither
 *     `sourceQuote` nor anything else the person did not write as the point.
 *   - Rule 2, a point is data: editing one cannot authorise anything; the
 *     prompt fences the profile as data whatever it says.
 *
 * Every read and write runs as the person (owner-only RLS on app.user_id).
 */

export interface RememberedPoint {
  id: string;
  text: string;
  /** When the person said it (or last edited it). */
  rememberedAt: string;
  editedByPerson: boolean;
}

export class MemoryPointNotFoundError extends Error {
  constructor() {
    super('That remembered point was not found.');
    this.name = 'MemoryPointNotFoundError';
  }
}

export class MemoryPointEmptyError extends Error {
  constructor() {
    super('A remembered point cannot be empty.');
    this.name = 'MemoryPointEmptyError';
  }
}

/** Shown and sent to the model: not replaced by a newer statement (rule 4). */
const LIVE = { supersededAt: null } as const;

export async function listRememberedPoints(userId: string): Promise<RememberedPoint[]> {
  const rows = await runAsUserOnly(userId, (db) =>
    db.assistantMemoryFact.findMany({
      where: { userId, ...LIVE },
      select: { id: true, text: true, sourceAt: true, editedByPerson: true },
      orderBy: { sourceAt: 'desc' },
      take: REMEMBERED_POINT_LIMIT,
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    rememberedAt: r.sourceAt.toISOString(),
    editedByPerson: r.editedByPerson,
  }));
}

export async function editRememberedPoint(
  userId: string,
  id: string,
  text: string,
): Promise<RememberedPoint> {
  const clean = sanitizePlainText(text).trim().slice(0, REMEMBERED_POINT_MAX_CHARS);
  if (!clean) throw new MemoryPointEmptyError();
  return runAsUserOnly(userId, async (db) => {
    const now = new Date();
    const { count } = await db.assistantMemoryFact.updateMany({
      where: { id, userId, ...LIVE },
      // The person's edit IS their own words: it becomes the evidence too.
      data: { text: clean, sourceQuote: clean, sourceAt: now, editedByPerson: true },
    });
    if (count === 0) throw new MemoryPointNotFoundError();
    return { id, text: clean, rememberedAt: now.toISOString(), editedByPerson: true };
  });
}

/** «Изтрий»: the point removed for good (rule 5). */
export async function forgetRememberedPoint(userId: string, id: string): Promise<void> {
  const { count } = await runAsUserOnly(userId, (db) =>
    db.assistantMemoryFact.deleteMany({ where: { id, userId, ...LIVE } }),
  );
  if (count === 0) throw new MemoryPointNotFoundError();
}

/**
 * «Забрави всичко»: every point removed for good, the replaced ones the person
 * no longer sees included. Returns how many the person saw (live points).
 */
export async function forgetAllRememberedPoints(userId: string): Promise<number> {
  return runAsUserOnly(userId, async (db) => {
    const live = await db.assistantMemoryFact.count({ where: { userId, ...LIVE } });
    await db.assistantMemoryFact.deleteMany({ where: { userId } });
    return live;
  });
}

/** The live points' text for the prompt, newest first (rule 4). */
export async function rememberedPointsForPrompt(userId: string): Promise<string[]> {
  const rows = await runAsUserOnly(userId, (db) =>
    db.assistantMemoryFact.findMany({
      where: { userId, ...LIVE },
      select: { text: true },
      orderBy: { sourceAt: 'desc' },
      take: REMEMBERED_POINT_LIMIT,
    }),
  );
  return rows.map((r) => r.text);
}
