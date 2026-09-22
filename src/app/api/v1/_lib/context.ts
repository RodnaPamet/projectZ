import type { Role } from '@prisma/client';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

import type { RequestContext } from '@/app-layer/types';
import type { PlayerzJWT } from '@/lib/auth/jwt-claims';
import { getPermissionsForRole } from '@/lib/permissions';

/**
 * Build the one object the app layer is allowed to trust.
 *
 * A use case never reads a cookie, a header or a session — `RequestContext` is
 * the sole carrier of "who is asking, about which club". This is where it is
 * assembled, and therefore the only place that can get it wrong.
 *
 * ═══ THE PER-TENANT BUG THIS EXISTS TO NOT REPEAT ═══
 *
 * `auth.ts` mints the JWT with `token.role` and `token.permissions` taken from
 * `memberships[0]` — whichever club the player joined FIRST. The edge
 * middleware then checks those permissions against the slug in the URL.
 *
 * An OWNER at club A who is merely a PLAYER at club B therefore carries
 * `admin.venue_manage` to club B: the membership check passes (they really are
 * a member of B) and the permission check passes (against A's role). That is
 * cross-tenant privilege escalation, and it is live the moment auth is mounted.
 *
 * So permissions are re-derived HERE from the membership that matches the slug
 * actually being addressed, and `token.role` / `token.permissions` are ignored
 * entirely. They are not read anywhere in this file, on purpose.
 *
 * ═══ NO SILENT TENANT ═══
 *
 * `tenantId` is null unless a slug was supplied AND the caller holds a
 * membership for it. There is deliberately no fallback to "their first club":
 * a mobile client that forgets the slug should get an empty tenant and a clean
 * 403 downstream, never somebody else's data because we guessed.
 */

export interface ContextInput {
  /** The `:slug` from the route, if this route has one. */
  slug?: string | null;
  requestId: string;
  locale?: 'bg' | 'en';
}

export async function contextFromRequest(
  req: NextRequest,
  input: ContextInput,
): Promise<RequestContext> {
  // Accepts a session cookie OR `Authorization: Bearer <jwe>` — next-auth's
  // getToken falls back to the header when no cookie is present, which is what
  // lets a native client reuse this pipeline unchanged.
  const raw = (await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  })) as unknown as PlayerzJWT | null;

  const base = {
    requestId: input.requestId,
    locale: input.locale ?? 'bg',
    appPermissions: [] as readonly string[],
  };

  if (!raw?.sub) {
    // Anonymous is a first-class case: public venue search, guest booking.
    return {
      ...base,
      userId: null,
      tenantId: null,
      tenantSlug: null,
      role: null,
      permissions: [],
    };
  }

  const slug = input.slug ?? null;
  if (!slug) {
    // Signed in, but not addressing a club: /me/**, account settings.
    return {
      ...base,
      userId: raw.sub,
      tenantId: null,
      tenantSlug: null,
      role: null,
      permissions: [],
    };
  }

  const membership = (raw.memberships ?? []).find((m) => m.tenantSlug === slug);

  if (!membership) {
    // Absent from a TRUNCATED list proves nothing — the caller may hold a
    // membership we could not fit in the token. Return no tenant rather than a
    // wrong one; the route resolves membership authoritatively against the
    // database, and RLS is the backstop either way.
    //
    // Denying here instead would lock a player out of their 51st club.
    return {
      ...base,
      userId: raw.sub,
      tenantId: null,
      tenantSlug: null,
      role: null,
      permissions: [],
    };
  }

  const role = membership.role as Role;

  return {
    ...base,
    userId: raw.sub,
    tenantId: membership.tenantId,
    tenantSlug: membership.tenantSlug,
    role,
    // Derived from THIS membership's role. Never from token.permissions.
    permissions: getPermissionsForRole(role),
  };
}
