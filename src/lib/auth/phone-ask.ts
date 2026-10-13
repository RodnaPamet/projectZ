/**
 * The one-time ask for a phone number after signing in (#500; owner decisions
 * 2026-10-13: existing accounts are asked at their next visit, and the step
 * can be skipped).
 *
 * The session token carries where the account stands, so the middleware can
 * send it to the phone step without a database read:
 *
 *   ok    a number is confirmed
 *   ask   a player or a coach with none: asked once, may say «Не сега»
 *   na    not asked: a club's account (staff act for the club), or an account
 *         that has not chosen its kind yet (that question comes first)
 *
 * A token minted before this existed has no claim. It is treated as `ask`:
 * the step page reads the database, and an account that is not to be asked
 * has its session refreshed there and goes on, with nothing asked.
 *
 * «Не сега» is a cookie in that browser, good for thirty days. It only stops
 * the ask: booking, joining a game and writing a message still need the
 * number, and offer the step themselves.
 *
 * No import: the middleware reads this.
 */

export type PhoneClaim = 'ok' | 'ask' | 'na';

export const PHONE_LATER_COOKIE = 'pz_phone_later';
/** Thirty days, in seconds. */
export const PHONE_LATER_MAX_AGE = 60 * 60 * 24 * 30;

export function phoneClaim(account: {
  accountKind: string | null;
  phoneVerifiedAt: Date | null;
}): PhoneClaim {
  if (account.phoneVerifiedAt) return 'ok';
  return account.accountKind === 'PLAYER' || account.accountKind === 'COACH' ? 'ask' : 'na';
}

/** Is this token's account still to be asked? Anything but `ok` and `na`. */
export function phoneStillToAsk(claim: unknown): boolean {
  return claim !== 'ok' && claim !== 'na';
}
