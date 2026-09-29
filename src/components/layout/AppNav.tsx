'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { useTranslations } from 'next-intl';

import type { NavItem } from './nav-items';

/**
 * playerz's own navigation.
 *
 * P02 deliberately did NOT port inflect's `SidebarNav` — its items are
 * `/controls`, `/risks`, `/evidence`, `/policies`, `/vendors`. That is a
 * compliance product's information architecture, and shipping it here would
 * have given a court-booking app a "Risks" sidebar.
 *
 * This is the sports IA instead. The design-system primitives underneath it
 * (Button, Tooltip, StatusBadge, CalendarMonth …) ARE the ported ones —
 * those were genuinely domain-neutral, which was the whole point of the
 * distinction.
 *
 * ═══ ONLY THE COMPONENT LIVES HERE ═══
 *
 * The item builders, `playerNav` and `adminNav`, are in `./nav-items`. This
 * module is `'use client'`, so anything it exports is a client reference to a
 * Server Component — calling one from the club layout threw, and every club
 * page was a 500 until #227 moved them. Export components from here, and
 * nothing a server needs to call. `client-boundary` holds that line.
 */

export type { NavItem };

export function AppNav({
  items,
  permissions = [],
}: {
  items: NavItem[];
  permissions?: readonly string[];
}) {
  const t = useTranslations('common.ui');
  const tNav = useTranslations('common.nav');
  const pathname = usePathname();

  // Hiding a link is a UI courtesy, NOT a security control. The route's own
  // permission middleware (P07) is what actually denies access — a hidden
  // link is still reachable by typing the URL.
  const visible = items.filter((i) => !i.requires || permissions.includes(i.requires));

  return (
    <nav aria-label={t('mainNav')} className="border-border-subtle flex gap-1 border-b">
      {visible.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-t-md px-4 py-2 text-sm transition-colors',
              active
                ? 'text-content-emphasis border-b-2 border-[var(--brand-default)] font-medium'
                : 'text-content-muted hover:text-content-default',
            )}
          >
            {tNav(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
