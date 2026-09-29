import { notFound, redirect } from 'next/navigation';

import { clubIndexTarget } from '@/lib/auth/landing';
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
 * the club's diary, a COACH to the coach UI once there is one, and everybody
 * else to the player UI — because a PLAYER at a club has no club-specific page
 * to see yet. The rule is `clubIndexTarget`.
 *
 * The layout above resolved this same context already; `resolveTenantPageContext`
 * is request-cached, so asking again is not a second query. The two branches
 * that are not `ok` repeat the layout's answers rather than trust that the
 * layout ran first — a page and its layout render concurrently.
 */
export default async function ClubIndexPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);

  if (result.kind === 'unauthenticated') {
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
  }
  if (result.kind === 'not-a-member') notFound();

  redirect(clubIndexTarget(result.ctx.role, result.ctx.tenantSlug));
}
