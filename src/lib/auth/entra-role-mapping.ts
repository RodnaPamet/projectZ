import type { Role } from '@prisma/client';

/**
 * Which role a user's Entra groups earn them, as a pure function.
 *
 * Separated from the sign-in path deliberately so the same ranking answers
 * both "what role does this user get?" at sign-in and "what role WOULD this
 * user get?" in an admin preview. Two implementations of that question would
 * eventually disagree, and the disagreement would surface as an administrator
 * insisting the mapping works while a player insists it does not.
 */

export interface GroupRoleMapping {
  aadGroupId: string;
  role: Role;
  priority: number;
}

export interface ResolvedGroupRole {
  /** The winning role, or null when the user matched no mapping. */
  role: Role | null;
  /** Every mapped group the user is actually in — for the audit trail and the gate. */
  matchedGroupIds: string[];
}

/**
 * Tie-break only, when two matched mappings share a priority.
 *
 * NOT an authority model. The administrator's explicit `priority` is the
 * primary signal; this exists so that equal priorities produce a STABLE answer
 * instead of one that depends on row order — a user whose role changes when
 * Postgres changes its mind about a scan is impossible to support.
 *
 * OWNER is absent because it is not mappable. See ENTRA_MAPPABLE_ROLES.
 */
const SENIORITY: Record<string, number> = {
  MANAGER: 40,
  COACH: 30,
  STAFF: 20,
  PLAYER: 10,
};

/**
 * NOTE ON WHAT IS DELIBERATELY NOT HERE
 *
 * The implementation this is ported from carries an `assignableRoles` ceiling,
 * applied before the winner is chosen, for its SCIM push path. playerz.bg has
 * no SCIM path, so porting the ceiling would add a parameter no caller sets
 * and no test exercises — machinery that looks load-bearing and is not. When a
 * SCIM path exists, the clamp must be applied BEFORE ranking, not after:
 * rejecting an out-of-ceiling winner at the call site silently discards a
 * legitimate lower mapping the same user also matched.
 */
export function resolveRoleFromGroups(
  aadGroups: readonly string[],
  mappings: readonly GroupRoleMapping[],
): ResolvedGroupRole {
  if (aadGroups.length === 0 || mappings.length === 0) {
    return { role: null, matchedGroupIds: [] };
  }

  // A Set because a user in an overage tenant can carry thousands of group
  // ids; a nested scan would be quadratic on the sign-in path.
  // Both sides lower-cased. Stored ids are normalised on write, but a row
  // written before that normalisation existed — or by a seed script — would
  // otherwise never match a claim.
  const held = new Set(aadGroups.map((g) => g.toLowerCase()));
  const matched = mappings.filter((m) => held.has(m.aadGroupId.toLowerCase()));

  if (matched.length === 0) return { role: null, matchedGroupIds: [] };

  const winner = [...matched].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (SENIORITY[b.role] ?? 0) - (SENIORITY[a.role] ?? 0);
  })[0]!;

  return {
    role: winner.role,
    // Every match, not just the winner: the audit entry records what the
    // decision was made from, and the gate asks "did ANY mapped group match?"
    matchedGroupIds: matched.map((m) => m.aadGroupId),
  };
}
