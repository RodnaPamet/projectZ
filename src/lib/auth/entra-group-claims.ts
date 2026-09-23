import { fetchUserGroupsFromGraph, type GraphGroupsResult } from './entra-graph';

/**
 * Which Entra security groups this user is in.
 *
 * ═══ "NO GROUPS" AND "WE DO NOT KNOW" ARE DIFFERENT ANSWERS ═══
 *
 * The implementation this is ported from returns `string[]` and fails open to
 * `[]`. That collapses two facts that call for opposite responses:
 *
 *   - the user genuinely belongs to no mapped group — with the group gate on,
 *     deny; that is the gate working;
 *   - Graph was unreachable — denying is a self-inflicted outage in which
 *     nobody at the club can sign in because Microsoft had a bad afternoon.
 *
 * Returning `[]` for both means the gate cannot tell them apart, and the more
 * damaging reading is the one it picks. So `complete` travels with the list
 * and the enforcement path is required to look at it.
 *
 * ═══ WHERE THE GROUPS COME FROM ═══
 *
 * Normally the `groups` claim on the ID token, which costs nothing. Entra
 * omits it above roughly 200 groups and substitutes `_claim_names.groups`; in
 * that case, and only then, we ask Graph.
 *
 * The `groups` claim's presence is governed by the CUSTOMER's app-registration
 * token configuration, not by anything here. A tenant that has not configured
 * it emits no claim and no overage pointer — which is indistinguishable from
 * genuine non-membership, and is why the gate is opt-in per club rather than
 * on by default.
 */

export interface EntraGroupClaims {
  groups: string[];
  source: 'token' | 'graph' | 'none';
  /** The `groups` claim was omitted for size and Graph was consulted. */
  overage: boolean;
  /** False when the full set could not be established. Never dressed up as []. */
  complete: boolean;
  /**
   * The Entra DIRECTORY these group ids came from (the `tid` claim).
   *
   * Group ids mean nothing without it. One resolution is applied to every club
   * the user belongs to, so a club must be able to check that the ids were
   * issued by ITS directory before matching them against its own mappings.
   * Null when the token carried no `tid`.
   */
  directoryTenantId: string | null;
}

interface EntraProfile {
  groups?: unknown;
  tid?: unknown;
  _claim_names?: { groups?: string };
}

export async function resolveEntraGroupClaims(
  input: { profile: unknown; accessToken?: string | null },
  deps: { fetchGroups?: typeof fetchUserGroupsFromGraph } = {},
): Promise<EntraGroupClaims> {
  const profile = (input.profile ?? {}) as EntraProfile;
  const fetchGroups = deps.fetchGroups ?? fetchUserGroupsFromGraph;

  const directoryTenantId = typeof profile.tid === 'string' ? profile.tid.toLowerCase() : null;
  const overageSignalled = Boolean(profile._claim_names?.groups);

  if (overageSignalled) {
    if (!input.accessToken) {
      // Entra says the list is too big to inline and we have no token to go
      // and get it. The one thing we know for certain is that the answer is
      // NOT "no groups" — the pointer only exists because there are many.
      // Reporting complete:false is the whole point of this branch.
      return { groups: [], source: 'none', overage: true, complete: false, directoryTenantId };
    }

    const result: GraphGroupsResult = await fetchGroups(input.accessToken);

    return {
      groups: result.groups,
      source: 'graph',
      overage: true,
      complete: result.complete,
      directoryTenantId,
    };
  }

  // A defensive guard, not decoration: `groups` is whatever the IdP put on the
  // token. A non-array there would otherwise throw inside the sign-in
  // callback, turning a malformed claim into a failed login.
  const raw = profile.groups;
  const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [];

  return {
    groups,
    source: groups.length > 0 ? 'token' : 'none',
    overage: false,
    // No overage pointer means the token carried the complete list — including
    // when that list is empty.
    complete: true,
    directoryTenantId,
  };
}
