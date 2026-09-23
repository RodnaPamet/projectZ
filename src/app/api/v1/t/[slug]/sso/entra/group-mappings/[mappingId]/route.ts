import { type NextRequest } from 'next/server';

import { EntraGroupMappingUpdateSchema } from '@/app-layer/schemas/entra-group-mapping';
import { deleteGroupMapping, updateGroupMapping } from '@/app-layer/usecases/entra-group-mappings';
import { hasPermission } from '@/app-layer/types';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toGroupMapping } from '@/app/api/v1/_lib/dto';
import { noContent, ok } from '@/app/api/v1/_lib/envelope';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * One mapping.
 *
 * DELETE is gated exactly as hard as POST. Removing a mapping stops a whole
 * directory group being granted their role at the next sign-in — a silent
 * mass revocation that presents as "SSO is broken" rather than as a change
 * somebody made, which is why the audit entry carries the full before-state.
 */
type Ctx = { params: Promise<{ slug: string; mappingId: string }> };

async function resolve(req: NextRequest, params: Ctx['params']) {
  const { slug, mappingId } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  if (!hasPermission(ctx, 'sso.manage')) {
    throw new ForbiddenError('Managing SSO group mappings requires the club owner');
  }

  return { ctx, mappingId };
}

async function patchHandler(req: NextRequest, { params }: Ctx) {
  const { ctx, mappingId } = await resolve(req, params);

  const raw = await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  });

  const parsed = EntraGroupMappingUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid group mapping', { issues: parsed.error.issues });
  }

  const mapping = await inTenant(ctx, (db) =>
    updateGroupMapping(db, ctx.tenantId!, ctx.userId!, mappingId, parsed.data),
  );

  return ok(toGroupMapping(mapping));
}

async function deleteHandler(req: NextRequest, { params }: Ctx) {
  const { ctx, mappingId } = await resolve(req, params);

  await inTenant(ctx, (db) => deleteGroupMapping(db, ctx.tenantId!, ctx.userId!, mappingId));

  return noContent();
}

export const PATCH = defineV1Route(patchHandler);
export const DELETE = defineV1Route(deleteHandler);
