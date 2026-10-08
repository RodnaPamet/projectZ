'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';

import { ArrowUpRight, CircleUser, UserArrowRight } from '@/components/ui/icons/nucleo';
import { Popover } from '@/components/ui/popover';

import { NavItem } from './nav-item';
import { PROFILE_HREF } from './nav-items';
import { USER_MENU_ROW_CLASS } from './user-menu';

/** Sign out to the homepage, not /login: landing on a sign-in form reads as "that failed". */
export function signOutHome() {
  void signOut({ callbackUrl: '/' });
}

/**
 * The account menu's own rows, after its built-in ones (the name, Тема,
 * Език): Профил, then Изход (#362, owner 2026-10-08). The same in every
 * shell, in the vendored `UserMenu`'s `items` slot, drawn as upstream's own
 * `TopChrome` draws its two: a `menuitem` link to the account's page, a
 * separator, a `menuitem` sign-out, in the menu's row recipe
 * (`USER_MENU_ROW_CLASS`, exported upstream for exactly this).
 */
export function AccountMenuRows({ close }: { close: () => void }) {
  const t = useTranslations('common');
  const tNav = useTranslations('common.nav');
  return (
    <>
      <Link
        href={PROFILE_HREF}
        role="menuitem"
        // Default (auto) prefetch: a menu row is not the tab bar.
        className={USER_MENU_ROW_CLASS}
        data-testid="user-menu-profile"
        onClick={close}
      >
        <CircleUser className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>{tNav('profile')}</span>
      </Link>
      <Popover.Separator />
      <button
        type="button"
        role="menuitem"
        className={USER_MENU_ROW_CLASS}
        data-testid="user-menu-sign-out"
        onClick={() => {
          close();
          signOutHome();
        }}
      >
        <UserArrowRight className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>{t('signOut')}</span>
      </button>
    </>
  );
}

/**
 * The way out of a club's or the platform's shell (#347) on a phone, where the
 * top bar has no room for it: one vendored `NavItem` row between the drawer's
 * sections and its foot. Nothing for a player, whose shell is the site.
 */
export function DrawerPublicSite({
  publicSite,
  onNavigate,
}: {
  publicSite: { href: string; label: string } | null;
  onNavigate: () => void;
}) {
  if (!publicSite) return null;
  return (
    <div className="border-border-subtle border-t p-2" data-testid="drawer-account">
      <NavItem
        href={publicSite.href}
        prefetch="auto"
        icon={ArrowUpRight}
        label={publicSite.label}
        active={false}
        onClick={onNavigate}
      />
    </div>
  );
}
