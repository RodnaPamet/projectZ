import { notFound, redirect } from 'next/navigation';

import { clubPublicHref } from '@/components/layout/nav-items';
import { clubIndexTarget, PLAYER_HOME } from '@/lib/auth/landing';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

/**
 * `/t/[slug]` — a club's front door, routed by the role held there (#227).
 *
 * ═══ TWO THINGS ALREADY SENT PEOPLE HERE, AND NOTHING WAS HERE ═══
 *
 *   - accepting an invite redirects to `/t/[slug]`;
 *   - the club layout, on a revoked session, sends sign-in back with
 *     `?next=/t/[slug]`.
 *
 * Both ended on a 404 — the second one hidden only because `/login` used to
 * ignore `?next=` entirely. Honouring it would have turned that into a 404
 * straight after signing in, so the address needs a page.
 *
 * It is `decideLanding` narrowed to one club: OWNER, MANAGER and STAFF go to
 * the club's diary, a COACH to the coach UI once there is one. The rule is
 * `clubIndexTarget`.
 *
 * ═══ EVERYONE ELSE: THE CLUB'S PUBLIC PAGE (#356, A03) ═══
 *
 * `clubIndexTarget` sends anyone without a club role to the player UI, because
 * a PLAYER at a club had no club page to see. Now there is one, `/clubs/{slug}`,
 * and that is where a player who opens the club's address goes. A signed-out
 * visitor is sent there too — by the edge, before this runs (src/middleware.ts),
 * and here as well, rather than trust that it did. The club page lives outside
 * `/t/` because this prefix is the members' namespace; see its page.tsx.
 *
 * A signed-in stranger still gets the layout's 404: the layout above cannot
 * tell this index from an admin page, and its answer must not differ between
 * "no such club" and "not yours".
 *
 * The layout above resolved this same context already; `resolveTenantPageContext`
 * is request-cached, so asking again is not a second query. The two branches
 * that are not `ok` repeat the layout's answers rather than trust that the
 * layout ran first — a page and its layout render concurrently.
 */
export default async function ClubIndexPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);

  if (result.kind === 'unauthenticated') redirect(clubPublicHref(slug));
  if (result.kind === 'not-a-member') notFound();

  const target = clubIndexTarget(result.ctx.role, result.ctx.tenantSlug);
  redirect(target === PLAYER_HOME ? clubPublicHref(result.ctx.tenantSlug) : target);
}
