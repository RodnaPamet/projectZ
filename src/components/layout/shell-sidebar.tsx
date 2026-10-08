'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Gear, Menu3, UserArrowRight } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

import { signOutHome } from './account-links';
import { NavItem } from './nav-item';
import { NAV_ICONS } from './nav-icons';
import type { ShellAccount, ShellNavSection } from './nav-items';
import { NavSection } from './nav-section';
import { useSidebarCollapsed } from './sidebar-collapse-context';

/**
 * Every shell's rail: playerz's sidebar CONTENT inside upstream's vendored
 * frame, for the club admin, the platform and the player (#362).
 *
 * Upstream's `SidebarContent` lives in its `SidebarNav.tsx` beside the
 * compliance IA (/risks, /controls, /evidence) and reads upstream's tenant
 * context, so it is not vendored. What is vendored is every part it is built
 * from: `NavSection`, `NavItem` (the band, the gloss, the 44 px touch row),
 * the collapse context, `Tooltip`, the icons and the `icon-btn` recipe. This
 * file only arranges them, in the order upstream's rail does: the collapse
 * control, the sections, then the account's foot.
 *
 * ═══ THE FOOT (owner, 2026-10-08) ═══
 *
 * Upstream's user block, on one row: the identity on the left (the name; the
 * club, or the account's kind; the role, or the platform grant), drawn as
 * upstream draws it, the name in `text-content-default` and the two lines
 * under it in `text-content-muted` (GAP-CI-77: no brand colour on small
 * text), and on the right the gear to the account's admin and
 * the sign-out button, each an `icon-btn icon-btn-sm` with a tooltip. In the
 * collapsed rail the identity is dropped and the two icons stack centred. The
 * gear is the club admin for a club account, `/platform` for a holder of a
 * live grant, and absent otherwise (`ShellAccount.admin`, decided on the
 * server).
 *
 * The same component fills the desktop rail and the phone drawer. The drawer
 * passes `onNavClick` and no `onToggleCollapse`: it is never collapsed, so it
 * shows the context name where the rail shows its toggle, and its `beforeFoot`
 * slot holds the way out to the public site that the phone's top bar has no
 * room for. The context is the club's name, the platform's, or for a player
 * the app's, as upstream's own rail names its app.
 *
 * `nav[aria-label=common.ui.mainNav]` is a contract: the perf harness and the
 * E2E specs find the links through it. So is `#admin-icon-link-desktop`, the
 * gear's id upstream's specs and tour select it by: the rail's only, so the
 * open drawer never doubles it.
 */
export function ShellSidebar({
  sections,
  contextName,
  account,
  onNavClick,
  onToggleCollapse,
  beforeFoot,
}: {
  sections: ShellNavSection[];
  /** The club's name, the platform's, or the app's. */
  contextName: string;
  /** The foot: who is signed in, and the gear (`ShellAccount`). */
  account: Pick<ShellAccount, 'identity' | 'admin'>;
  onNavClick?: () => void;
  onToggleCollapse?: () => void;
  /** The drawer's rows between the sections and the foot. */
  beforeFoot?: ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const tUi = useTranslations('common.ui');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const collapsed = useSidebarCollapsed();
  const inRail = onToggleCollapse !== undefined;
  const { identity, admin } = account;

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
                // A literal, and never a full prefetch from a sidebar
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

      {beforeFoot}

      <div className="border-border-subtle border-t p-3" data-testid="sidebar-account">
        <div
          className={cn(
            'gap-tight flex',
            collapsed ? 'flex-col items-center' : 'items-center justify-between',
          )}
        >
          {!collapsed && (
            <div className="min-w-0" data-testid="sidebar-identity">
              <p className="text-content-default truncate text-xs font-medium">{identity.name}</p>
              {identity.context ? (
                <p className="text-content-muted truncate text-xs">{identity.context}</p>
              ) : null}
              {identity.role ? <p className="text-content-muted text-xs">{identity.role}</p> : null}
            </div>
          )}
          <div
            className={cn('gap-tight flex', collapsed ? 'flex-col items-center' : 'items-center')}
          >
            {admin ? (
              <Tooltip content={admin.label} side={collapsed ? 'right' : 'top'}>
                <Link
                  href={admin.href}
                  aria-label={admin.label}
                  id={inRail ? 'admin-icon-link-desktop' : undefined}
                  data-testid="nav-admin-icon"
                  className="icon-btn icon-btn-sm"
                  onClick={onNavClick}
                >
                  <Gear className="size-4" aria-hidden="true" />
                </Link>
              </Tooltip>
            ) : null}
            <Tooltip content={tCommon('signOut')} side={collapsed ? 'right' : 'top'}>
              <button
                type="button"
                onClick={signOutHome}
                aria-label={tCommon('signOut')}
                data-testid="nav-logout"
                className="icon-btn icon-btn-sm"
              >
                <UserArrowRight className="size-4" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
