import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { countActiveOwners, listStaff } from '@/app-layer/repositories/staff';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { StaffBoard, type StaffRow } from './StaffBoard';

export async function generateMetadata() {
  const t = await getTranslations('admin.staff');
  return { title: t('metaTitle') };
}

/**
 * Who runs the club.
 *
 * ═══ THE OWNER COUNT IS QUERIED, NOT COUNTED FROM THE LIST ═══
 *
 * `listStaff` is capped at 200, so a club with more members could miss an
 * owner outside the page. Counting from that partial view errs in the
 * RESTRICTIVE direction — a missed owner only makes the count look smaller, so
 * it would refuse a legitimate demotion rather than permit a lockout.
 *
 * (This comment used to claim the opposite. It is worth being exact: the
 * permissive direction is the dangerous one, and a truncated list cannot reach
 * it.)
 *
 * The reasons to query are that it is cheap and exact. The reason it is SAFE
 * is different: the use case counts again inside the transaction before
 * acting, because the number this page rendered is a request away from being
 * stale. That second count is what actually prevents the lockout.
 */
export default async function StaffPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('admin.staff_manage')) notFound();

  const t = await getTranslations('admin.staff');

  const { members, activeOwnerCount } = await runInTenantContext(ctx.tenantId, async (db) => ({
    members: await listStaff(db, ctx.tenantId),
    activeOwnerCount: await countActiveOwners(db, ctx.tenantId),
  }));

  const rows = members.map((m): StaffRow => ({
    membershipId: m.membershipId,
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.status,
  }));

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <StaffBoard
        slug={slug}
        members={rows}
        viewerUserId={ctx.userId}
        canManageOwners={ctx.permissions.includes('admin.owner_management')}
        activeOwnerCount={activeOwnerCount}
      />
    </section>
  );
}
