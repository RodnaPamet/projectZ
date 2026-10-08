import type { BreadcrumbItem } from '@/components/ui/breadcrumbs';
import { PLAY_PATH } from '@/lib/auth/landing';
import type { ResourceNouns } from '@/lib/sports/resource-kinds';

import { clubAdminHref, clubAdminNav, PLATFORM_HREF, platformNav, PROFILE_HREF } from './nav-items';

/**
 * EVERY SHELL PAGE'S BREADCRUMBS (#362, owner 2026-10-08: the top bar's left
 * slot as upstream's `TopChrome` has it).
 *
 * A page builds its trail here, on the server, and hands it to the vendored
 * `PageBreadcrumbs`, which pushes it into the shell's `BreadcrumbsProvider`
 * (the top bar draws it from `md`) and draws it inline below `md`, as
 * upstream's pages do. The labels and hrefs come from the nav's own items, so
 * a crumb never names a page differently from the sidebar: the courts screen
 * is "Писти" at a karting club here too. Plain data, no component: the page
 * is a server component and `PageBreadcrumbs` a client one.
 *
 * The last crumb is the page itself: the vendored `Breadcrumbs` draws it as
 * the current page, never as a link, whatever its href.
 */

/** `common.nav`, as the server page holds it. */
type NavT = (key: string) => string;

/** A page that is the trail's leaf: its own name, from the page's data. */
const leaf = (label: string | null | undefined): BreadcrumbItem[] => (label ? [{ label }] : []);

/** Играй, and a page under it (a venue, a club). */
export function playCrumbs(t: NavT, page?: string | null): BreadcrumbItem[] {
  return [{ label: t('play'), href: PLAY_PATH }, ...leaf(page)];
}

/** Резервации, and one booking (its venue's name, the page's heading). */
export function bookingsCrumbs(t: NavT, booking?: string | null): BreadcrumbItem[] {
  return [{ label: t('bookings'), href: '/me/bookings' }, ...leaf(booking)];
}

/** Профил. */
export function profileCrumbs(t: NavT): BreadcrumbItem[] {
  return [{ label: t('profile'), href: PROFILE_HREF }];
}

/** The club admin's pages, by their segment under `/t/{slug}/admin`. */
export type ClubAdminPage =
  'calendar' | 'courts' | 'pricing' | 'photos' | 'players' | 'staff' | 'reports';

/**
 * Администрация (the club admin's home), and one of its pages under the
 * label the sidebar gives it. Without a page, the home alone.
 */
export function clubAdminCrumbs(
  slug: string,
  t: NavT,
  page?: ClubAdminPage,
  nouns?: ResourceNouns,
): BreadcrumbItem[] {
  const home: BreadcrumbItem = { label: t('admin'), href: clubAdminHref(slug) };
  if (!page) return [home];
  const href = `${clubAdminHref(slug)}/${page}`;
  const item = clubAdminNav(slug, nouns)
    .flatMap((s) => s.items)
    .find((i) => i.href === href);
  if (!item) throw new Error(`clubAdminCrumbs: no club admin page "${page}"`);
  return [home, { label: t(item.labelKey), href }];
}

/** The platform's pages, by their segment under `/platform`. */
export type PlatformPage = 'moderation' | 'fees' | 'usage' | 'contact-requests' | 'security';

/** Платформа, one of its pages under the sidebar's label, and a leaf below it. */
export function platformCrumbs(
  t: NavT,
  page: PlatformPage,
  below?: string | null,
): BreadcrumbItem[] {
  const href = `${PLATFORM_HREF}/${page}`;
  const item = platformNav()
    .flatMap((s) => s.items)
    .find((i) => i.href === href);
  if (!item) throw new Error(`platformCrumbs: no platform page "${page}"`);
  return [
    { label: t('platform'), href: PLATFORM_HREF },
    { label: t(item.labelKey), href },
    ...leaf(below),
  ];
}
