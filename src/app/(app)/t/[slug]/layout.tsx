import { notFound, redirect } from 'next/navigation';

import { AppNav, adminNav, playerNav } from '@/components/layout/AppNav';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

/**
 * The authenticated club shell — the first layout in this repo that renders a
 * navigation bar.
 *
 * ═══ `AppNav` HAD NO RENDERER AT ALL ═══
 *
 * It was written, translated, permission-gated and tested, and no layout
 * mounted it. #176 says of its five admin links "any owner or manager sees five
 * nav links that 404 — that is user-facing today"; measured, nothing rendered
 * the nav, so nobody could see them. The links were unreachable rather than
 * broken. This is what makes them reachable, which is why the pages have to
 * exist in the same change.
 *
 * ═══ WHY THE URL CARRIES THE SLUG ═══
 *
 * The nav pointed at bare `/admin/courts`. That path is UNGUARDED:
 * `tenantSlugFromPath` finds no slug, `checkTenantAccess` falls through to its
 * `allow` default, and `requiredPermission` returns null because every rule in
 * `route-permissions.ts` is anchored at `^/api/`. An anonymous visitor would
 * have reached it — `guard.ts` warns about exactly this shape, in prose, three
 * lines above the branch that does it.
 *
 * `/t/[slug]/admin/*` is matched by both, and by `page-segregation` and
 * `canonical-parents`, which already assume that shape.
 *
 * ═══ THE EDGE IS NOT THE ONLY CHECK ═══
 *
 * Middleware gates membership before this runs. This resolves it again, from
 * the database, because the edge can only read the token — and `token.role` is
 * frozen to the club the user joined FIRST. Deriving authority from it is the
 * documented cross-tenant escalation. One indexed query buys the correct
 * answer and a truncated membership list stops mattering.
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

  const { ctx } = result;

  return (
    <div className="bg-bg-page text-content-default safe-area-top safe-area-x min-h-screen">
      <AppNav
        items={[...playerNav(ctx.tenantSlug), ...adminNav(ctx.tenantSlug)]}
        permissions={ctx.permissions}
      />
      <main className="px-6 py-8">{children}</main>
    </div>
  );
}
