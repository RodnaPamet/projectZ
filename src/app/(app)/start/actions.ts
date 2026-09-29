'use server';

import { redirect } from 'next/navigation';

import { rememberLandingContext } from '@/app-layer/usecases/landing';
import { requireSignedIn } from '@/lib/auth/page-context';

/**
 * The role switcher's one action: remember the choice, then go there (#227).
 *
 * ═══ WHY THIS ONE DOES NOT CALL requireTenantAction ═══
 *
 * It is not an action AT a club. It changes one column on the caller's own
 * `app_user` row, and "player" — one of the values it accepts — names no club
 * at all. What it demands instead:
 *
 *   - a signed-in user with a live session (`requireSignedIn` runs
 *     `checkSession`, so a revoked session cannot switch);
 *   - a key that names a context the caller holds RIGHT NOW. The use case
 *     re-derives the caller's contexts from the database and refuses anything
 *     else, so a forged `club:<another club>` is never stored — and it would
 *     grant nothing if it were, because `decideLanding` re-checks on read and
 *     every club page resolves membership itself.
 *
 * `server-actions-authorise` lists this file by name with that reasoning.
 *
 * ═══ ERRORS ARE RETURNED, NOT THROWN ═══
 *
 * `redirect` throws to navigate, and a thrown error would read to the client as
 * the same kind of event. A stale switcher (the membership was suspended after
 * the page rendered) is an ordinary outcome that the menu says something about.
 */
export type SwitchContextResult = { error: 'SIGN_IN_REQUIRED' | 'NOT_AVAILABLE' };

export async function switchContextAction(key: unknown): Promise<SwitchContextResult> {
  const userId = await requireSignedIn();
  if (!userId) return { error: 'SIGN_IN_REQUIRED' };

  // Untrusted: whatever the POST carried. Bounded before it reaches a query.
  if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
    return { error: 'NOT_AVAILABLE' };
  }

  const chosen = await rememberLandingContext(userId, key);
  if (!chosen) return { error: 'NOT_AVAILABLE' };

  // Outside any try: `redirect` works by throwing.
  redirect(chosen.href);
}
