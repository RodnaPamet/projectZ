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
  /**
   * A key under `common.nav`, NOT display text.
   *
   * ═══ WHY THIS IS A KEY AND NOT A STRING ═══
   *
   * These were literal English — 'Play', 'Calendar', 'Courts' — rendered
   * straight into the nav of an app whose default locale is Bulgarian. Nine
   * user-visible strings, on the most visible surface there is.
   *
   * They survived because `i18n-no-hardcoded-copy` is an AST scan of JSX: it
   * reads text nodes and copy-carrying ATTRIBUTES. These lived in a plain
   * object literal at module scope and were rendered as `{item.label}` — a JSX
   * expression, not a text node. Copy declared in a data structure and rendered
   * through a variable was invisible to it, which is a blind spot worth knowing
   * about rather than a gap in the rule.
   *
   * Naming the field `labelKey` rather than `label` is deliberate: `label` is
   * in that guardrail's COPY_ATTRS set, so a future `label="Courts"` on a JSX
   * element WOULD be caught — and a field called `label` holding a key invites
   * somebody to put text back in it.
   */
  labelKey: string;
  /** Hidden unless the viewer holds this permission. */
  requires?: string;
}

/**
 * ═══ WHY THESE ARE FUNCTIONS OF A SLUG ═══
 *
 * They were constants pointing at bare `/admin/courts`, and that path is
 * UNGUARDED. `tenantSlugFromPath` finds no slug in it, so `checkTenantAccess`
 * falls through to its `allow` default; and `requiredPermission` returns null
 * because every rule in `route-permissions.ts` is anchored at `^/api/`. An
 * anonymous visitor would have reached the page.
 *
 * `guard.ts` warns about precisely this: "a tenant URL shape this regex does
 * NOT recognise is not merely unmatched, it is UNGUARDED, and
 * `requiredPermission` goes quiet at the same moment for the same reason."
 *
 * Nothing rendered this nav, so nobody could click them — but the shape was
 * the trap waiting for whoever mounted it. Taking a slug makes the guarded
 * shape the only one expressible.
 */

/** The player-facing surface. */
export function playerNav(slug: string): NavItem[] {
  return [
    // Discovery stays global: a player browsing venues is not yet at a club,
    // and this is the one page that exists today.
    { href: '/venues', labelKey: 'play' },
    { href: `/t/${slug}/open-play`, labelKey: 'openPlay' },
    { href: `/t/${slug}/coaches`, labelKey: 'coaches' },
    { href: `/t/${slug}/my-bookings`, labelKey: 'myBookings' },
  ];
}

/** The venue-staff surface. Each item is permission-gated. */
export function adminNav(slug: string): NavItem[] {
  return [
    { href: `/t/${slug}/admin/calendar`, labelKey: 'calendar', requires: 'bookings.view_all' },
    { href: `/t/${slug}/admin/courts`, labelKey: 'courts', requires: 'courts.manage' },
    { href: `/t/${slug}/admin/pricing`, labelKey: 'pricing', requires: 'admin.pricing_manage' },
    { href: `/t/${slug}/admin/players`, labelKey: 'players', requires: 'players.view' },
    { href: `/t/${slug}/admin/staff`, labelKey: 'staff', requires: 'admin.staff_manage' },
  ];
}

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
