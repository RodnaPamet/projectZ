'use server';

import { redirect } from 'next/navigation';

import { acceptInvite, InviteNeedsAnotherAccountError } from '@/app-layer/usecases/invites';
import type { AccountKindRefusal } from '@/lib/auth/account-kind';
import { requireSignedIn } from '@/lib/auth/page-context';
import { accountKindViolation } from '@/lib/db/pg-errors';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * Accepting an invite.
 *
 * ═══ WHY THIS ONE DOES NOT CALL requireTenantAction ═══
 *
 * Every other Server Action in this repo demands a permission at a club. This
 * one is how somebody BECOMES a member of that club — there is no membership
 * to check, and demanding one would make the invite unusable by exactly the
 * people it is for.
 *
 * What it demands instead is a signed-in user, because a membership has to
 * belong to an account. The authorisation is the token: 32 random bytes,
 * stored only as a keyed hash, single-use and expiring, delivered to an
 * address somebody with access to that club chose.
 *
 * `server-actions-authorise` allows this file by name, with that reasoning, so
 * the exemption is a decision somebody made rather than a gap.
 *
 * ═══ WHY runAsSuperuser ═══
 *
 * The same chicken-and-egg as `page-context`: the work is finding out WHICH
 * tenant this token belongs to, so there is no `app.tenant_id` to bind yet.
 * The lookup is by a hash of a secret the caller supplied; it cannot enumerate.
 * And since #263 it asks what else the account holds, at every club.
 *
 * ═══ TWO KINDS OF "NO" ═══
 *
 * `NOT_USABLE` covers expired, revoked, spent and never-existed, and must not
 * say which: telling them apart lets somebody probe for live tokens. A
 * refusal of the ACCOUNT (#263) is the opposite case — the token works, and
 * the person needs to be told exactly what to do: accept with a separate
 * account. That one is returned by name.
 */
export type AcceptInviteError = 'SIGN_IN_REQUIRED' | 'NOT_USABLE' | AccountKindRefusal;

export async function acceptInviteAction(token: string): Promise<{ error: AcceptInviteError }> {
  const userId = await requireSignedIn();
  if (!userId) return { error: 'SIGN_IN_REQUIRED' };

  let slug: string;
  try {
    const result = await runAsSuperuser((db) => acceptInvite(db, token, userId));
    slug = result.tenantSlug;
  } catch (err) {
    if (err instanceof InviteNeedsAnotherAccountError) return { error: err.refusal };

    // The database's refusal, when the application's check was overtaken: a
    // brand-new account accepting two staff invites at once is let into the
    // first club and refused the second — it is a club account of that club
    // now. Anything else it refuses is a mix of kinds all the same.
    const rule = accountKindViolation(err);
    if (rule === 'one_club') return { error: 'CLUB_ACCOUNT_TAKEN' };
    if (rule) return { error: 'SEPARATE_ACCOUNT_REQUIRED' };

    // One message for expired, revoked, spent and never-existed. Telling them
    // apart lets somebody probe for live tokens.
    return { error: 'NOT_USABLE' };
  }

  redirect(`/t/${slug}`);
}
