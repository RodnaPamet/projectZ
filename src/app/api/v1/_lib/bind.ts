import type { Prisma, PrismaClient } from '@prisma/client';

import type { RequestContext } from '@/app-layer/types';
import { runAsSuperuser, runAsUserOnly, runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * The three ways a v1 route gets a database handle, and there is no fourth.
 *
 * Each one binds a different RLS context, and picking the wrong one does not
 * raise — it returns ZERO ROWS. An empty list reads as "you have no bookings"
 * rather than "this query was bound wrong", which is why the choice is made
 * explicit at the route rather than inferred.
 *
 *   inTenant      app.tenant_id set    → tenant-scoped tables
 *   asUser        app.user_id set      → owner-scoped tables (no tenant)
 *   asSuperuser   BYPASSRLS            → cross-tenant, and obvious in review
 */

export class MissingTenantError extends Error {
  constructor() {
    super(
      'inTenant() was called on a context with no tenantId. The route resolved no ' +
        'membership for the slug it was given, so there is nothing to bind to. ' +
        'Reject the request (403) before reaching for a database handle — binding ' +
        'to no tenant would return zero rows and look like an empty club.',
    );
    this.name = 'MissingTenantError';
  }
}

export class MissingUserError extends Error {
  constructor() {
    super(
      'asUser() was called on an anonymous context. Owner-scoped tables are keyed ' +
        'on app.user_id; with no user there is no owner, and every policy fails ' +
        'closed. Require authentication before calling this.',
    );
    this.name = 'MissingUserError';
  }
}

/**
 * Tenant-scoped work: bookings, venues, courts, sessions, members.
 *
 * Throws rather than binding to nothing. A caller that reaches here without a
 * tenant has already made a mistake upstream, and the useful failure is loud
 * and immediate rather than an empty page three screens later.
 *
 * `isolationLevel` exists because this is the OUTERMOST transaction on the
 * path — a use case asking for SERIALIZABLE on the handle it receives gets a
 * SAVEPOINT and silently keeps READ COMMITTED. See runInTenantContext.
 */
export async function inTenant<T>(
  ctx: RequestContext,
  fn: (db: PrismaClient) => Promise<T>,
  opts: { isolationLevel?: Prisma.TransactionIsolationLevel } = {},
): Promise<T> {
  // `async` so the guard REJECTS rather than throwing synchronously. A function
  // typed `Promise<T>` that can throw before returning one is a trap: the
  // obvious `inTenant(...).catch(handle)` never runs the handler, and the
  // exception escapes as an unhandled throw in the route.
  if (!ctx.tenantId) throw new MissingTenantError();
  return runInTenantContext(ctx.tenantId, fn, undefined, opts);
}

/**
 * Owner-scoped work with NO tenant: notifications, push subscriptions,
 * wearable connections.
 *
 * These are person-scoped by design — your notifications are yours at every
 * club you belong to, not yours-at-this-club. A player with three memberships
 * has one notification list.
 *
 * Tenant-scoped tables return zero rows in here. That is the documented
 * trade-off of having no tenant bound, not a bug to work around: if a route
 * needs both, it needs two calls, and it needs to have thought about why.
 */
export async function asUser<T>(
  ctx: RequestContext,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  if (!ctx.userId) throw new MissingUserError();
  return runAsUserOnly(ctx.userId, fn);
}

/**
 * BYPASSRLS. Public cross-tenant reads (the venue index spans every club),
 * platform admin, and sign-in, which must read a User before any tenant exists.
 *
 * Deliberately verbose to type. Every call site should be obvious in review,
 * because this is the one binding with no safety net underneath it.
 */
export async function asSuperuser<T>(
  _ctx: RequestContext,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  return runAsSuperuser(fn);
}
