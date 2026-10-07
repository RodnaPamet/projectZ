import 'next-auth';
import 'next-auth/jwt';

import type { MembershipClaim } from '@/lib/auth/jwt-claims';
import type { Permission } from '@/lib/permissions';

// Module augmentation, NOT `any` casts. A cast here would let a typo in a
// claim name compile — and a claim the middleware reads but the JWT never
// sets is a permission check that silently always fails open or closed.
declare module 'next-auth/jwt' {
  interface JWT {
    tenantId?: string | null;
    tenantSlug?: string | null;
    role?: string | null;
    permissions?: Permission[];
    memberships?: MembershipClaim[];
    membershipsTruncated?: boolean;
  }
}

declare module 'next-auth' {
  interface Session {
    userId?: string;
    tenantId?: string | null;
    tenantSlug?: string | null;
    role?: string | null;
    permissions?: Permission[];
    memberships?: MembershipClaim[];
    membershipsTruncated?: boolean;
  }
}
