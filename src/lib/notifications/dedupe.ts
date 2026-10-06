/**
 * Dedupe keys (#367): what makes a notification idempotent per (event,
 * recipient).
 *
 * `notification` and `email_outbox` are both unique on `(userId, dedupeKey)`,
 * and every write is `ON CONFLICT DO NOTHING`. So a hook that runs twice, a
 * cron that overlaps itself, or a retry after a timeout writes the row once.
 *
 * ═══ THE DAILY CAP IS THE SAME PRIMITIVE ═══
 *
 * "Email about new messages at most once per conversation per day" (Q22,
 * for #375) is a key that names the conversation and the DAY, in the
 * recipient's club's timezone: the first message of the day writes the email,
 * and every later one that day collides and writes nothing. No counter, no
 * lookup, no race.
 */

/** `booking:<id>:<event>` and similar. Parts may not contain the separator. */
export function dedupeKey(...parts: Array<string | number>): string {
  for (const p of parts) {
    // A part with the separator in it could make two events share a key.
    if (String(p).length === 0 || String(p).includes(':')) {
      throw new Error('A dedupe key part must be non-empty and contain no ":"');
    }
  }
  return parts.join(':');
}

/** `YYYY-MM-DD` of `at` on the wall clock of `timeZone`. */
export function localDay(at: Date, timeZone: string): string {
  // en-CA formats a date as ISO `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * At most once per `scope` per local day: `message:<conversationId>:2026-10-25`.
 * For #375's message emails; built now so the cap has one definition.
 */
export function dailyDedupeKey(
  scope: string,
  id: string,
  at: Date,
  timeZone = 'Europe/Sofia',
): string {
  return dedupeKey(scope, id, localDay(at, timeZone));
}
