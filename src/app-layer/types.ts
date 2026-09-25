import type { Role } from '@prisma/client';

import type { Permission } from '@/lib/permissions';
import type { PlatformCapability } from '@/lib/platform/capabilities';

/**
 * The request context every use case receives.
 *
 * It is the ONLY carrier of identity and tenancy into the app layer. A use
 * case never reads a session, a cookie, or a header itself — that keeps the
 * app layer testable without a web server, and makes "who is asking?" a
 * parameter rather than ambient state.
 */
export interface RequestContext {
  /** Null for anonymous traffic: public venue search, guest booking. */
  userId: string | null;
  /** Null on non-tenant routes (the public venue index). */
  tenantId: string | null;
  tenantSlug: string | null;
  role: Role | null;
  /** Tenant-scoped permissions, resolved from the role + any custom role. */
  permissions: readonly Permission[];
  /**
   * Cross-club authority. Empty for essentially every request.
   *
   * ═══ WHY THIS IS A UNION AND NOT `readonly string[]` ═══
   *
   * It was `readonly string[]` and unread — declared, hardcoded to `[]` in the
   * context builder, and consulted by nothing. The type is the reason that was
   * dangerous rather than merely unfinished: against a bare string list,
   * `appPermissions.includes('tenant_read')` compiles, always returns false,
   * and looks exactly like "correctly denied" in every test anyone would think
   * to write. A typo would have been a permanent silent deny; a *renamed*
   * capability would be a permanent silent ALLOW of the wrong thing.
   *
   * `permissions` above already has this protection. This now does too.
   */
  appPermissions: readonly PlatformCapability[];
  /**
   * The grant these capabilities came from, for the audit trail. Null unless
   * the caller holds a live platform grant.
   *
   * Carried separately from `appPermissions` because the audit row records
   * WHICH grant authorised an action, and "the capabilities were non-empty" is
   * not an answer to that.
   */
  platformGrantId: string | null;
  requestId: string;
  locale: 'bg' | 'en';
}

export function hasPermission(ctx: RequestContext, permission: Permission): boolean {
  return ctx.permissions.includes(permission);
}

/**
 * Whether the caller holds a platform capability.
 *
 * Deliberately a SEPARATE function from `hasPermission`, typed to a different
 * union, so the two can never be confused at a call site. A tenant permission
 * cannot satisfy a platform check and vice versa — which matters because the
 * tenant list is generous (an OWNER holds every tenant permission there is)
 * and the platform list is meant to be held by almost nobody.
 */
export function hasAppPermission(ctx: RequestContext, capability: PlatformCapability): boolean {
  return ctx.appPermissions.includes(capability);
}
