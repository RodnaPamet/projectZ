import { Palette } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { clubResourceNouns } from '@/app-layer/usecases/club-nouns';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { NAV_ICONS } from '@/components/layout/nav-icons';
import { clubAdminNav, visibleSections } from '@/components/layout/nav-items';
import { buttonVariants } from '@/components/ui/button-variants';
import { Eyebrow, Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

export async function generateMetadata() {
  const t = await getTranslations('admin.home');
  return { title: t('metaTitle') };
}

/**
 * `/t/[slug]/admin`: the club admin's home, which the sidebar foot's gear
 * opens (#362, owner 2026-10-08: the admin buttons, in the same places as
 * upstream's). It was a redirect to the first page the role opens (audit C10),
 * written when the address had no page of its own and answered 404.
 *
 * Upstream's admin page, in playerz's terms: the heading with the theme row
 * beside it (`#admin-theme-section`, `ThemeToggle id="admin-theme-toggle"`,
 * upstream's `admin/page.tsx`), then one button for every admin page the role
 * opens, grouped under the sidebar's own section titles. The list is the
 * filter the admin layout draws the sidebar with, over the same membership
 * (`resolveTenantPageContext`, request-cached), so this page never offers a
 * page the sidebar would not, and so never one that answers 404. The courts
 * screen is named after what the club plays on, as in the sidebar.
 *
 * The layout above has already refused a stranger and a member with no admin
 * page; those two branches are repeated here rather than trusted, because a
 * page and its layout render concurrently.
 */
export default async function ClubAdminHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);

  if (result.kind === 'unauthenticated') {
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}/admin`)}`);
  }
  if (result.kind === 'not-a-member') notFound();

  const { ctx } = result;
  const [t, tNav, tCommon, nouns] = await Promise.all([
    getTranslations('admin.home'),
    getTranslations('common.nav'),
    getTranslations('common'),
    clubResourceNouns(ctx.tenantId),
  ]);
  const sections = visibleSections(clubAdminNav(ctx.tenantSlug, nouns), (item) =>
    ctx.permissions.includes(item.requires),
  );
  if (sections.length === 0) notFound();

  return (
    <section className="space-y-section">
      <header className="gap-default flex flex-wrap items-center justify-between">
        <Heading level={1}>{t('title')}</Heading>
        <div
          className="gap-compact border-border-subtle bg-bg-default flex items-center rounded-lg border px-3 py-1.5"
          id="admin-theme-section"
        >
          <Palette className="text-content-muted h-4 w-4" aria-hidden="true" />
          <span className="text-content-muted text-sm">{tCommon('theme')}</span>
          <ThemeToggle id="admin-theme-toggle" />
        </div>
      </header>

      {sections.map((section) => {
        const title = section.titleKey ? tNav(section.titleKey) : null;
        return (
          <section
            key={section.items[0]!.href}
            className="space-y-default"
            aria-label={title ?? undefined}
          >
            {title ? <Eyebrow>{title}</Eyebrow> : null}
            <div className="gap-tight flex flex-wrap">
              {section.items.map((item) => {
                const Icon = NAV_ICONS[item.iconKey];
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={buttonVariants({ variant: 'secondary' })}
                    data-testid={`admin-home-${item.href.split('/').pop()}`}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {tNav(item.labelKey)}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </section>
  );
}
