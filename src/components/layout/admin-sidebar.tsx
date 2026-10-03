'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Menu3 } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';

import { NavItem } from './nav-item';
import { NAV_ICONS } from './nav-icons';
import type { ShellNavSection } from './nav-items';
import { NavSection } from './nav-section';
import { useSidebarCollapsed } from './sidebar-collapse-context';

/**
 * The admin shell's rail: playerz's sidebar CONTENT inside upstream's vendored frame.
 *
 * Upstream's `SidebarContent` lives in its `SidebarNav.tsx` beside the
 * compliance IA (/risks, /controls, /evidence) and reads upstream's tenant
 * context, so it is not vendored. What is vendored is every part it is built
 * from: `NavSection`, `NavItem` (the band, the gloss, the 44 px touch row) and
 * the collapse context. This file only arranges them, in the order upstream's
 * rail does: the collapse control, then the sections.
 *
 * The same component fills the desktop rail and the phone drawer. The drawer
 * passes `onNavClick` and no `onToggleCollapse`: it is never collapsed, so it
 * shows the context name where the rail shows its toggle.
 *
 * `nav[aria-label=common.ui.mainNav]` is a contract: the perf harness and the
 * E2E specs find the links through it.
 */
export function AdminSidebar({
  sections,
  contextName,
  onNavClick,
  onToggleCollapse,
}: {
  sections: ShellNavSection[];
  /** The club's name, or the platform's. */
  contextName: string;
  onNavClick?: () => void;
  onToggleCollapse?: () => void;
}) {
  const pathname = usePathname() ?? '';
  const tUi = useTranslations('common.ui');
  const tNav = useTranslations('nav');
  const collapsed = useSidebarCollapsed();

  return (
    <div className="flex h-full flex-col">
      <div className="border-border-subtle border-b p-4">
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? tNav('expandSidebar') : tNav('collapseSidebar')}
            aria-pressed={collapsed}
            data-testid="sidebar-collapse-toggle"
            className={cn(
              'text-content-muted hover:text-content-emphasis flex min-h-7 w-full items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none',
              collapsed ? 'justify-center' : 'gap-tight',
            )}
          >
            <Menu3 className="h-5 w-5 shrink-0" aria-hidden="true" />
            {!collapsed && (
              <span className="text-content-emphasis truncate text-sm font-semibold">
                {contextName}
              </span>
            )}
          </button>
        ) : (
          <p className="text-content-emphasis truncate text-sm font-semibold">{contextName}</p>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label={tUi('mainNav')}>
        {sections.map((section, idx) => (
          <NavSection
            key={section.title ?? `section-${idx}`}
            title={section.title}
            isFirst={idx === 0 || sections.findIndex((s) => s.title) === idx}
          >
            {section.items.map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                // A literal, and never a full prefetch in the admin
                // (docs/perf/navigation-policy.md): `router-cache-policy`
                // pins every <NavItem> to it, and nav-items.ts types the
                // items to match.
                prefetch="auto"
                icon={NAV_ICONS[item.iconKey]}
                label={item.label}
                active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
                onClick={onNavClick}
              />
            ))}
          </NavSection>
        ))}
      </nav>
    </div>
  );
}
