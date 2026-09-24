'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { useTranslations } from 'next-intl';

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
 */

export interface NavItem {
  href: string;
  label: string;
  /** Hidden unless the viewer holds this permission. */
  requires?: string;
}

/** The player-facing surface. */
export const PLAYER_NAV: NavItem[] = [
  { href: '/venues', label: 'Play' },
  { href: '/open-play', label: 'Open play' },
  { href: '/coaches', label: 'Coaches' },
  { href: '/my-bookings', label: 'My bookings' },
];

/** The venue-staff surface. Each item is permission-gated. */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin/calendar', label: 'Calendar', requires: 'bookings.view_all' },
  { href: '/admin/courts', label: 'Courts', requires: 'courts.manage' },
  { href: '/admin/pricing', label: 'Pricing', requires: 'admin.pricing_manage' },
  { href: '/admin/players', label: 'Players', requires: 'players.view' },
  { href: '/admin/staff', label: 'Staff', requires: 'admin.staff_manage' },
];

export function AppNav({
  items,
  permissions = [],
}: {
  items: NavItem[];
  permissions?: readonly string[];
}) {
  const t = useTranslations('common.ui');
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
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
