'use server';

import { redirect } from 'next/navigation';

import { acceptInvite } from '@/app-layer/usecases/invites';
import { requireSignedIn } from '@/lib/auth/page-context';
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
 */
export async function acceptInviteAction(token: string): Promise<{ error: string } | never> {
  const userId = await requireSignedIn();
  if (!userId) return { error: 'SIGN_IN_REQUIRED' };

  let slug: string;
  try {
    const result = await runAsSuperuser((db) => acceptInvite(db, token, userId));
    slug = result.tenantSlug;
  } catch {
    // One message for expired, revoked, spent and never-existed. Telling them
    // apart lets somebody probe for live tokens.
    return { error: 'NOT_USABLE' };
  }

  redirect(`/t/${slug}`);
}
