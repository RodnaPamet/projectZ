import type { PrismaClient, Role } from '@prisma/client';

import { parseEntraConfig, readGroupGateFlag } from '@/app-layer/schemas/entra-provider';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { recordEntraRoleSync } from '@/lib/observability/metrics';

import type { EntraGroupClaims } from './entra-group-claims';
import { resolveRoleFromGroups } from './entra-role-mapping';

/**
 * Applying a club's Entra group mappings to one membership, at sign-in.
 *
 * ═══ IT UPDATES A MEMBERSHIP, IT NEVER CREATES ONE ═══
 *
 * A group mapping decides what role an existing member holds. It does not
 * decide who is a member. Creating memberships here would mean anyone in a
 * directory group silently joins the club by signing in — turning a role
 * mapping into an enrolment mechanism, which is not what an administrator
 * configuring one believes they are doing.
 *
 * ═══ OWNER IS IMMUNE, BOTH WAYS ═══
 *
 * Never demoted and never gate-denied. A mapping is configuration, and
 * configuration can be wrong; the failure mode of a wrong mapping must not be
 * a club with no owner, or an owner locked out of the club they own with
 * nobody able to let them back in.
 *
 * playerz.bg has no general last-OWNER guard — there is currently no code path
 * anywhere that writes `TenantMembership.role`, so there has been nothing to
 * guard. This immunity is what protects ownership on THIS path. A general
 * guard belongs with manual staff management when that route is built, and
 * this is not a substitute for it.
 *
 * ═══ MATCHING NOTHING LEAVES YOU ALONE. MATCHING SOMETHING APPLIES IT. ═══
 *
 * Stated precisely, because an earlier draft of this comment claimed the rule
 * was "a role is only ever raised, never lowered" — and the code did not do
 * that. A mapping that resolves to a LOWER role than the member currently
 * holds does apply, and that is deliberate: a mapping says "people in this
 * group hold this role", and an administrator who maps a group to STAFF means
 * it. Refusing to lower would make a mapping unable to correct an
 * over-promotion, which is the main reason anyone edits one.
 *
 * What never happens is demotion by SILENCE. Matching no mapped group leaves
 * the existing role untouched, because "the directory said nothing about this
 * person" is not an instruction. Removing access is done by removing the
 * membership or by enabling the gate — both deliberate acts.
 */

export interface EntraRoleSyncResult {
  /** The role the membership carries after this ran, or null if there is none. */
  effectiveRole: Role | null;
  /** True when a role UPDATE was actually written. */
  changed: boolean;
  /** True when the group gate denied access for this session. */
  gateDenied: boolean;
}

const NO_OP: EntraRoleSyncResult = { effectiveRole: null, changed: false, gateDenied: false };

export async function syncEntraMembershipRole(
  db: PrismaClient,
  input: { userId: string; tenantId: string; claims: EntraGroupClaims },
): Promise<EntraRoleSyncResult> {
  const { userId, tenantId, claims } = input;

  // The provider row governs whether this club federates at all, and it is
  // read FIRST — before mappings — for a reason found in review: deriving the
  // gate decision from the existence of mappings meant that deleting the last
  // mapping at a gated club silently admitted everyone. A gate whose
  // enforcement depends on there being something to match is not a gate.
  const provider = await db.tenantIdentityProvider.findFirst({
    where: { tenantId, type: 'ENTRA_ID', enabled: true },
    select: { configJson: true },
  });

  // `enabled` is honoured here rather than ignored. A club that switches its
  // Entra integration off expects it to stop doing things — both stop
  // assigning roles AND stop denying access.
  if (!provider) {
    recordEntraRoleSync({ outcome: 'no_mappings' });
    return NO_OP;
  }

  // Read off the raw JSON rather than a fully-validated config: a corrupt
  // unrelated field must not be able to switch a security control off.
  const gateEnforced = readGroupGateFlag(provider.configJson);
  const config = parseEntraConfig(provider.configJson);

  const mappings = await db.tenantEntraGroupMapping.findMany({
    where: { tenantId },
    // Deterministic. Without an order, a club with more mappings than the cap
    // gets an arbitrary subset, so which role wins could change between two
    // sign-ins with no configuration having changed.
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: { aadGroupId: true, role: true, priority: true },
    take: 200,
  });

  const membership = await db.tenantMembership.findFirst({
    where: { userId, tenantId, status: 'ACTIVE' },
    select: { id: true, role: true },
  });

  // ═══ GROUP IDS ARE ONLY MEANINGFUL WITHIN THEIR OWN DIRECTORY ═══
  //
  // One sign-in resolves one group list, from whichever Entra directory the
  // user actually authenticated against — and that list is then offered to
  // EVERY club they belong to. Without this check, a club would match ids
  // issued by somebody else's directory against its own mappings.
  //
  // Treated as "cannot establish membership" rather than "no groups": the ids
  // are not wrong, they are simply not about this club. Denying on them would
  // lock a member out of club B for signing in through club A's directory.
  if (config?.aadTenantId && claims.directoryTenantId !== config.aadTenantId.toLowerCase()) {
    recordEntraRoleSync({ outcome: 'unresolved' });
    return { effectiveRole: membership?.role ?? null, changed: false, gateDenied: false };
  }

  if (membership?.role === 'OWNER') {
    recordEntraRoleSync({ outcome: 'owner_immune' });
    return { effectiveRole: 'OWNER', changed: false, gateDenied: false };
  }

  // ═══ "WE DO NOT KNOW" IS NOT "NO GROUPS" ═══
  //
  // An incomplete list means Graph was unreachable or truncated. Promoting on
  // it would act on a guess; DENYING on it would turn a Microsoft outage into
  // a club-wide lockout, because every member would match nothing.
  //
  // So neither. The user keeps whatever role their membership already carries
  // and signs in normally — the state they were in a minute ago, which is the
  // only defensible answer when the input is missing.
  if (!claims.complete) {
    recordEntraRoleSync({ outcome: 'unresolved' });
    return { effectiveRole: membership?.role ?? null, changed: false, gateDenied: false };
  }

  const { role: mappedRole, matchedGroupIds } = resolveRoleFromGroups(claims.groups, mappings);

  // Evaluated even when the club has NO mappings, which is the literal
  // reading: "you must be in a mapped group" with no mapped groups admits
  // nobody. That is drastic, and it is recoverable — OWNER is immune above, so
  // the club owner can always sign in and add a mapping. Admitting everyone
  // instead would mean the gate quietly stops working at the exact moment a
  // configuration mistake is made.
  if (gateEnforced && matchedGroupIds.length === 0) {
    recordEntraRoleSync({ outcome: 'gate_denied' });
    return { effectiveRole: null, changed: false, gateDenied: true };
  }

  if (mappings.length === 0) {
    recordEntraRoleSync({ outcome: 'no_mappings' });
    return { effectiveRole: membership?.role ?? null, changed: false, gateDenied: false };
  }

  if (!mappedRole) {
    recordEntraRoleSync({ outcome: 'no_match' });
    return { effectiveRole: membership?.role ?? null, changed: false, gateDenied: false };
  }

  if (!membership) {
    // A mapping matched, but there is nobody to apply it to. Membership
    // creation stays on the invite path deliberately.
    recordEntraRoleSync({ outcome: 'no_membership' });
    return { effectiveRole: null, changed: false, gateDenied: false };
  }

  if (membership.role === mappedRole) {
    recordEntraRoleSync({ outcome: 'unchanged' });
    return { effectiveRole: mappedRole, changed: false, gateDenied: false };
  }

  // The update and its audit row share one transaction. A role change with no
  // record is the thing the audit log was built for — and this is the first
  // code in the application that changes a role at all, so it is also the
  // first that could produce one.
  await db.$transaction(async (tx) => {
    await tx.tenantMembership.update({
      where: { id: membership.id },
      data: { role: mappedRole },
    });

    await appendAuditEntry(tx as unknown as PrismaClient, {
      tenantId,
      actorUserId: null,
      // Nobody decided this. A person edited a directory group, possibly for
      // unrelated reasons, possibly months ago. Recording it as USER would
      // attribute it to whoever happened to sign in.
      actorType: 'SYSTEM',
      entity: 'TenantMembership',
      entityId: membership.id,
      action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
      details: `Entra group sync: ${membership.role} → ${mappedRole}`,
      detailsJson: {
        category: 'access',
        summary: 'Membership role synced from an Entra group mapping',
        targetUserId: userId,
        before: { role: membership.role },
        after: { role: mappedRole },
        source: 'entra_group_sync',
        matchedGroupIds,
      },
    });
  });

  recordEntraRoleSync({ outcome: 'synced' });

  return { effectiveRole: mappedRole, changed: true, gateDenied: false };
}
