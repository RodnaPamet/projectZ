import { notFound, redirect } from 'next/navigation';

import { clubAdminNav, visibleSections } from '@/components/layout/nav-items';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

/**
 * `/t/[slug]/admin` — the club admin's own address, which was a 404 (audit C10).
 *
 * It sends a member on to the FIRST page of the admin nav that their role
 * opens: the diary for OWNER, MANAGER and STAFF, the players for a COACH. The
 * same filter the admin layout uses to draw the sidebar, so this never lands
 * anybody on a page the sidebar would not offer them, and therefore never on
 * a page that would answer 404.
 *
 * The layout above has already refused a stranger and a member with no admin
 * page; those two branches are repeated here rather than trusted, because a
 * page and its layout render concurrently.
 */
export default async function ClubAdminIndexPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);

  if (result.kind === 'unauthenticated') {
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}/admin`)}`);
  }
  if (result.kind === 'not-a-member') notFound();

  const { ctx } = result;
  const first = visibleSections(clubAdminNav(ctx.tenantSlug), (item) =>
    ctx.permissions.includes(item.requires),
  )[0]?.items[0];
  if (!first) notFound();

  redirect(first.href);
}
