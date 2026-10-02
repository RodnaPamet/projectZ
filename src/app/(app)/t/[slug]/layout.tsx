import { notFound, redirect } from 'next/navigation';

import { resolveTenantPageContext } from '@/lib/auth/page-context';

/**
 * The club's membership gate, and nothing else.
 *
 * ═══ THE CHROME MOVED DOWN A LEVEL (T19) ═══
 *
 * This layout used to render the site header, the club nav (nine links in one
 * row: #255, 541-555 px of sideways scroll on a 393 px phone) and a <main>.
 * The chrome now lives in `admin/layout.tsx`, on inflect's vendored shell,
 * because everything with a screen under `/t/[slug]` is an admin screen:
 * `page.tsx` here only redirects (to the diary, or out of the club for a
 * role with no club page). Rendering chrome here as well would wrap the admin
 * shell in a second header and a second <main>, which axe reports.
 *
 * ═══ WHY THE URL CARRIES THE SLUG ═══
 *
 * A bare `/admin/courts` is UNGUARDED: `tenantSlugFromPath` finds no slug,
 * `checkTenantAccess` falls through to its `allow` default, and
 * `requiredPermission` returns null because every rule in
 * `route-permissions.ts` is anchored at `^/api/`. `/t/[slug]/admin/*` is
 * matched by both, and by `page-segregation` and `canonical-parents`.
 *
 * ═══ THE EDGE IS NOT THE ONLY CHECK ═══
 *
 * Middleware gates membership before this runs. This resolves it again, from
 * the database, because the edge can only read the token — and `token.role` is
 * frozen to the club the user joined FIRST. Deriving authority from it is the
 * documented cross-tenant escalation. `resolveTenantPageContext` is
 * request-cached, so the admin layout and every page beneath asking again is
 * not a second query.
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);

  if (result.kind === 'unauthenticated') {
    // `next` so sign-in returns them where they were going, rather than to a
    // dashboard they then have to navigate out of.
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
  }

  if (result.kind === 'not-a-member') {
    // 404, not 403. "No such club" and "not a member of it" must be
    // indistinguishable or this is a tenant-enumeration oracle — the same
    // reasoning `checkTenantAccess` and `/t/[slug]/me` already apply.
    notFound();
  }

  return children;
}
