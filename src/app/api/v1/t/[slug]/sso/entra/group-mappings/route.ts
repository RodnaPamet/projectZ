import { type NextRequest } from 'next/server';

import { EntraGroupMappingCreateSchema } from '@/app-layer/schemas/entra-group-mapping';
import { createGroupMapping, listGroupMappings } from '@/app-layer/usecases/entra-group-mappings';
import { hasPermission } from '@/app-layer/types';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toGroupMapping } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Entra group → role mappings for one club.
 *
 * ═══ THE PERMISSION IS CHECKED HERE TOO ═══
 *
 * ROUTE_PERMISSIONS gates the mutating verbs on `sso.manage` at the edge, and
 * that is the primary enforcement. It is repeated in the handler for GET,
 * which the edge does NOT gate — `requiredPermission` returns null for
 * non-mutating methods, so a read of this collection would otherwise be open
 * to every member of the club.
 *
 * That matters more than it looks: the list tells you which directory groups
 * confer which role, which is a map of how to get administrative access to
 * this club. It is not sensitive because it contains secrets; it is sensitive
 * because it is reconnaissance.
 */
function requireSsoManage(ctx: Parameters<typeof hasPermission>[0]) {
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  if (!hasPermission(ctx, 'sso.manage')) {
    throw new ForbiddenError('Managing SSO group mappings requires the club owner');
  }
}

async function listHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  requireSsoManage(ctx);

  const mappings = await inTenant(ctx, (db) => listGroupMappings(db, ctx.tenantId!));

  return ok(mappings.map(toGroupMapping));
}

async function createHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  requireSsoManage(ctx);

  const raw = await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  });

  const parsed = EntraGroupMappingCreateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid group mapping', { issues: parsed.error.issues });
  }

  const mapping = await inTenant(ctx, (db) =>
    createGroupMapping(db, ctx.tenantId!, ctx.userId!, parsed.data),
  );

  return ok(toGroupMapping(mapping), { status: 201 });
}

export const GET = defineV1Route(listHandler);
export const POST = defineV1Route(createHandler);
