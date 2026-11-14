import { contentFingerprint, wasEditedByUser, type EventContent, type ExistingEvent } from './api';

/**
 * The difference between what the calendar should hold and what it holds
 * (owner 2026-11-14), as a pure function, ported from the loop in agri-saas
 * `usecases/calendar-google-sync.ts`.
 *
 * ## Absence is not evidence
 *
 * A sync deletes what is no longer wanted, so it must be sure an absence
 * means that. Three ways it would not:
 *
 *  1. THE WINDOW. The schedule is read from 30 days back to a year ahead. An
 *     event outside that range is missing from the desired set because of
 *     the range, not because the game was cancelled; deleting it would erase
 *     the person's history a little more every day. So only an event whose
 *     own start is inside the window may be deleted.
 *  2. A TRUNCATED SCHEDULE. Each read is capped; a capped read is incomplete
 *     and everything it dropped looks cancelled. No deletion then.
 *  3. A TRUNCATED CALENDAR. The calendar is read back page by page up to a
 *     bound. Past it, an absence proves nothing in the other direction too: a
 *     "missing" event may be on a page we did not read, so creating it would
 *     make a duplicate. Neither deletes nor creates then.
 *
 * Creates and updates still run where they are safe, and `partial` says that
 * something was held back rather than reporting a clean sync.
 *
 * ## The person's edit wins
 *
 * An event whose content no longer matches the fingerprint we wrote was
 * changed by them. It is neither updated nor deleted: it is theirs now.
 */

export interface PlannedSync {
  create: Array<{ playerzId: string; content: EventContent }>;
  update: Array<{ eventId: string; playerzId: string; content: EventContent }>;
  remove: string[];
  unchanged: number;
  skippedEdited: number;
  partial: boolean;
}

export function planSync(input: {
  desired: ReadonlyMap<string, EventContent>;
  existing: readonly ExistingEvent[];
  window: { from: Date; to: Date };
  /** The schedule read hit a cap. */
  scheduleTruncated: boolean;
  /** The calendar was read back to its end. */
  calendarComplete: boolean;
}): PlannedSync {
  const { desired, existing, window } = input;
  const mayDelete = !input.scheduleTruncated && input.calendarComplete;
  const from = window.from.getTime();
  const to = window.to.getTime();

  const plan: PlannedSync = {
    create: [],
    update: [],
    remove: [],
    unchanged: 0,
    skippedEdited: 0,
    partial: input.scheduleTruncated || !input.calendarComplete,
  };
  const seen = new Set<string>();

  for (const ev of existing) {
    const want = desired.get(ev.playerzId);
    // A second event for an id we already matched (a create whose answer was
    // lost, then made again) is treated as unwanted: the first one stands.
    const duplicate = seen.has(ev.playerzId);
    seen.add(ev.playerzId);

    if (!want || duplicate) {
      const t = Date.parse(ev.start);
      const inWindow = !Number.isNaN(t) && t >= from && t <= to;
      if (!mayDelete || !inWindow) continue;
      if (wasEditedByUser(ev)) {
        plan.skippedEdited++;
        continue;
      }
      plan.remove.push(ev.eventId);
      continue;
    }

    if (wasEditedByUser(ev)) {
      plan.skippedEdited++;
      continue;
    }
    if (ev.writtenHash === contentFingerprint(want) && ev.currentHash === ev.writtenHash) {
      plan.unchanged++;
      continue;
    }
    plan.update.push({ eventId: ev.eventId, playerzId: ev.playerzId, content: want });
  }

  if (input.calendarComplete) {
    for (const [playerzId, content] of desired) {
      if (!seen.has(playerzId)) plan.create.push({ playerzId, content });
    }
  }
  return plan;
}
