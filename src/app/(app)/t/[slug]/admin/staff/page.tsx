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
 * `listStaff` is capped at 200. A club with more members than that would be
 * answering "is this the last owner?" from a partial view — and answering it
 * wrong in the permissive direction, which is the direction that locks a club
 * out of its own account.
 *
 * The use case counts it again before acting, because this number is a render
 * away from being stale.
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
