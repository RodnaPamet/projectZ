import { randomUUID } from 'node:crypto';

/**
 * A rate-limit key no other test can collide with.
 *
 * ═══ WHY NOT `clearAllRateLimits()` IN A beforeEach ═══
 *
 * Because it deletes EVERY `ratelimit:*` key, and jest runs unit files in
 * parallel workers against ONE Redis. Two files both clearing in `beforeEach`
 * means one file's clear lands between another's fifth and sixth attempt, that
 * file's counter resets, and its "the eleventh request is refused" assertion
 * gets a 200.
 *
 * Measured, in both directions, on the same test:
 *
 *   - with a random IP from a 200-address space and NO clear, state persisted in
 *     Redis between runs (it did not with the old in-memory Map), so a repeated
 *     address arrived already throttled and the FIRST attempt returned 429
 *   - adding a clear fixed that and introduced the opposite failure: the
 *     ELEVENTH attempt returned 200, because a sibling file's clear had wiped
 *     the counter mid-test
 *
 * Both are the same underlying mistake: sharing a key space and then trying to
 * manage it. A unique key needs no management. It cannot collide with a sibling
 * file, a parallel worker, or a previous run, and the Lua script PEXPIREs it, so
 * nothing accumulates.
 *
 * `getClientIp` returns `x-forwarded-for` verbatim without validating it
 * (rate-limit-middleware.ts:87-93), so this does not have to be a real address —
 * but it looks like one, because a value that appears in a 429 log line should
 * read as what it stands for.
 */
export function uniqueTestIp(): string {
  // 10.0.0.0/8 is private, and three octets of UUID entropy make a collision
  // across every test and every run vanishingly unlikely.
  const hex = randomUUID().replace(/-/g, '');
  const octet = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `10.${octet(0)}.${octet(2)}.${octet(4)}`;
}
