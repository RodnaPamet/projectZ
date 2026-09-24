/**
 * Postgres SQLSTATE extraction.
 *
 * P09's `createBooking` deliberately does NOT check "is this slot free?" —
 * under concurrency that check always loses. It attempts the INSERT and
 * maps `23P01` (exclusion_violation) to conflict('slot_taken'). That design
 * is only safe if we can reliably tell 23P01 from every other failure, so
 * this helper is load-bearing, not a convenience.
 *
 * Prisma 7 makes it harder than it should be: the top-level `code` is
 * Prisma's own `P2010`, and the real SQLSTATE sits at a depth that varies
 * with how the driver adapter classified the violation (a unique violation
 * gets a mapped `kind` + `originalCode`; an exclusion or CHECK violation
 * has no mapped kind and carries the raw pg error instead), and it is
 * re-wrapped again inside a `$transaction`.
 *
 * Hard-coding one path silently returns `undefined` the moment Prisma
 * shifts it — and `undefined !== '23P01'` would mean a double-booking
 * conflict surfacing as a 500 instead of a clean "someone just took this
 * slot". So we walk the graph.
 */

/** 5 characters: two digits then three alphanumerics. e.g. 23P01, 23505. */
const SQLSTATE = /^\d{2}[0-9A-Z]{3}$/;

export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
/**
 * The transaction could not be serialized and was aborted.
 *
 * Not a bug and not a data problem: SERIALIZABLE is DOING ITS JOB, and the
 * documented response is to retry. Code that runs at that isolation level has
 * to be able to tell this apart from a genuine failure, or it treats a routine
 * abort as an outage.
 */
export const PG_SERIALIZATION_FAILURE = '40001';

export function pgErrorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);

    for (const [key, value] of Object.entries(cur as Record<string, unknown>)) {
      if (
        (key === 'originalCode' || key === 'code') &&
        typeof value === 'string' &&
        SQLSTATE.test(value)
      ) {
        return value;
      }
      if (value && typeof value === 'object') stack.push(value);
    }

    // Error.cause is not enumerable on every engine.
    const cause = (cur as { cause?: unknown }).cause;
    if (cause) stack.push(cause);
  }

  return undefined;
}

export function isExclusionViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_EXCLUSION_VIOLATION;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_CHECK_VIOLATION;
}

export function isSerializationFailure(err: unknown): boolean {
  return pgErrorCode(err) === PG_SERIALIZATION_FAILURE;
}
