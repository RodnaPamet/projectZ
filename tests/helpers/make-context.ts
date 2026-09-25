import type { RequestContext } from '@/app-layer/context';

/**
 * A valid RequestContext with sensible defaults and spread overrides.
 *
 * Defaults to an ANONYMOUS context on purpose: a test that needs
 * privileges must ask for them. If the default were an OWNER with every
 * permission, a policy test could pass while the policy did nothing.
 */
export function buildRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    userId: null,
    tenantId: null,
    tenantSlug: null,
    role: null,
    permissions: [],
    // Defaults to NO platform authority for the same reason the role defaults
    // to null: a test that needs cross-club reach must ask for it by name.
    // A default that carried a capability would let a platform-authorisation
    // test pass while the check did nothing.
    appPermissions: [],
    platformGrantId: null,
    requestId: 'test-request',
    locale: 'bg',
    ...overrides,
  };
}
