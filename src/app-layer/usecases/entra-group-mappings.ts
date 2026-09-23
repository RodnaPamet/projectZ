import type { PrismaClient, Role } from '@prisma/client';

import {
  ENTRA_MAPPABLE_ROLES,
  type EntraGroupMappingCreate,
  type EntraGroupMappingUpdate,
} from '@/app-layer/schemas/entra-group-mapping';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { isUniqueViolation } from '@/lib/db/pg-errors';

/**
 * Managing which Entra group grants which role.
 *
 * ═══ EVERY CHANGE HERE IS AUDITED, IN THE SAME TRANSACTION ═══
 *
 * These rows decide who can administer a club. A mapping added quietly is a
 * standing grant to everyone in a directory group this application does not
 * control, and a mapping REMOVED quietly is a whole group silently losing
 * access at their next sign-in — the second is less obvious and more likely to
 * be blamed on something else.
 *
 * The audit write shares the caller's transaction, so a mapping cannot exist
 * without its record, and a record cannot exist for a mapping that was never
 * written.
 */

export class RoleNotMappableError extends Error {
  readonly code = 'role_not_mappable';
  constructor(role: string) {
    super(
      `${role} cannot be granted by an Entra group. OWNER carries the ability to ` +
        `suspend the club and to change who owns it, so it stays manually assigned.`,
    );
    this.name = 'RoleNotMappableError';
  }
}

export class DuplicateGroupMappingError extends Error {
  readonly code = 'duplicate_group_mapping';
  constructor() {
    super('That Entra group is already mapped at this club. Edit the existing mapping instead.');
    this.name = 'DuplicateGroupMappingError';
  }
}

export class MappingNotFoundError extends Error {
  readonly code = 'mapping_not_found';
  constructor() {
    super('No such group mapping.');
    this.name = 'MappingNotFoundError';
  }
}

/**
 * Belt and braces over the Zod enum.
 *
 * The schema already refuses OWNER at the HTTP boundary. This exists because
 * the use case is also reachable from a seed script, a job, or a future admin
 * tool that never passes through that schema — and "the caller validated it"
 * is exactly the assumption that stops being true without anyone noticing.
 */
function assertMappable(role: string): asserts role is Role {
  if (!(ENTRA_MAPPABLE_ROLES as readonly string[]).includes(role)) {
    throw new RoleNotMappableError(role);
  }
}

export async function createGroupMapping(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  input: EntraGroupMappingCreate,
) {
  assertMappable(input.role);

  try {
    const mapping = await db.tenantEntraGroupMapping.create({
      data: {
        tenantId,
        aadGroupId: input.aadGroupId,
        aadGroupName: input.aadGroupName ?? null,
        role: input.role,
        priority: input.priority,
      },
    });

    await appendAuditEntry(db, {
      tenantId,
      actorUserId,
      entity: 'TenantEntraGroupMapping',
      entityId: mapping.id,
      action: AUDIT_ACTIONS.SSO_GROUP_MAPPING_CREATED,
      details: `Entra group ${input.aadGroupId} now grants ${input.role}`,
      detailsJson: {
        category: 'access',
        summary: 'Entra group mapping created',
        after: { aadGroupId: input.aadGroupId, role: input.role, priority: input.priority },
      },
    });

    return mapping;
  } catch (err) {
    // The unique index arbitrates, not a read-then-write: two admins adding
    // the same group at once would both see "not present" and both insert.
    if (isUniqueViolation(err)) throw new DuplicateGroupMappingError();
    throw err;
  }
}

export async function updateGroupMapping(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  mappingId: string,
  input: EntraGroupMappingUpdate,
) {
  if (input.role !== undefined) assertMappable(input.role);

  // Read first for the BEFORE state. An audit entry that records only the new
  // value answers "what is it now?", which anyone can see by looking — the
  // question an investigation asks is what it changed FROM.
  const before = await db.tenantEntraGroupMapping.findFirst({
    where: { id: mappingId, tenantId },
  });

  if (!before) throw new MappingNotFoundError();

  const mapping = await db.tenantEntraGroupMapping.update({
    where: { id: before.id },
    data: {
      ...(input.aadGroupName !== undefined ? { aadGroupName: input.aadGroupName } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'TenantEntraGroupMapping',
    entityId: mapping.id,
    action: AUDIT_ACTIONS.SSO_GROUP_MAPPING_UPDATED,
    details: `Entra group ${before.aadGroupId}: ${before.role} → ${mapping.role}`,
    detailsJson: {
      category: 'access',
      summary: 'Entra group mapping updated',
      before: { role: before.role, priority: before.priority },
      after: { role: mapping.role, priority: mapping.priority },
    },
  });

  return mapping;
}

export async function deleteGroupMapping(
  db: PrismaClient,
  tenantId: string,
  actorUserId: string,
  mappingId: string,
) {
  const before = await db.tenantEntraGroupMapping.findFirst({
    where: { id: mappingId, tenantId },
  });

  if (!before) throw new MappingNotFoundError();

  await db.tenantEntraGroupMapping.delete({ where: { id: before.id } });

  // The row is gone, so the audit entry is the ONLY remaining evidence that
  // this group ever granted anything. It carries the full before-state for
  // that reason, not for symmetry with the other two.
  await appendAuditEntry(db, {
    tenantId,
    actorUserId,
    entity: 'TenantEntraGroupMapping',
    entityId: before.id,
    action: AUDIT_ACTIONS.SSO_GROUP_MAPPING_DELETED,
    details: `Entra group ${before.aadGroupId} no longer grants ${before.role}`,
    detailsJson: {
      category: 'access',
      summary: 'Entra group mapping deleted',
      before: {
        aadGroupId: before.aadGroupId,
        aadGroupName: before.aadGroupName,
        role: before.role,
        priority: before.priority,
      },
    },
  });
}

export async function listGroupMappings(db: PrismaClient, tenantId: string) {
  return db.tenantEntraGroupMapping.findMany({
    where: { tenantId },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    // A club with more mapped groups than this has a configuration problem,
    // not a pagination problem.
    take: 200,
  });
}
