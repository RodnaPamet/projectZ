'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import type { ComponentType, SVGProps } from 'react';

import {
  ArrowUpRight,
  CircleUser,
  ShieldCheck,
  UserArrowRight,
} from '@/components/ui/icons/nucleo';

import { NavItem } from './nav-item';
import type { AccountLinks } from './nav-items';
import { NavSection } from './nav-section';
import { USER_MENU_ROW_CLASS } from './user-menu';

interface Row {
  key: string;
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * An account's rows (`AccountLinks`, decided on the server; #362, #345, #347),
 * in the one order both surfaces use. Sign-out is not a row: it is not a place.
 */
function useRows(links: AccountLinks): Row[] {
  const t = useTranslations('common.nav');
  const rows: Row[] = [];
  if (links.publicSite) {
    rows.push({
      key: 'public',
      href: links.publicSite.href,
      label: links.publicSite.label,
      icon: ArrowUpRight,
    });
  }
  if (links.profileHref) {
    rows.push({ key: 'profile', href: links.profileHref, label: t('profile'), icon: CircleUser });
  }
  if (links.platformHref) {
    rows.push({
      key: 'platform',
      href: links.platformHref,
      label: t('platform'),
      icon: ShieldCheck,
    });
  }
  return rows;
}

function signOutHome() {
  // The homepage, not /login: landing on a sign-in form reads as "that failed".
  void signOut({ callbackUrl: '/' });
}

/**
 * The rows inside the vendored `UserMenu`'s `items` slot, in its own row
 * recipe (`USER_MENU_ROW_CLASS`, exported upstream for exactly this), with
 * sign-out last. The menu's built-in rows (identity, theme) stay above them.
 */
export function AccountMenuRows({ links, close }: { links: AccountLinks; close: () => void }) {
  const t = useTranslations('common');
  return (
    <>
      {useRows(links).map((row) => (
        <Link
          key={row.key}
          href={row.href}
          // Default (auto) prefetch: a menu row is not the tab bar.
          className={USER_MENU_ROW_CLASS}
          data-testid={`user-menu-${row.key}`}
          onClick={close}
        >
          <row.icon className="size-4" aria-hidden="true" />
          {row.label}
        </Link>
      ))}
      <button
        type="button"
        className={USER_MENU_ROW_CLASS}
        data-testid="user-menu-sign-out"
        onClick={() => {
          close();
          signOutHome();
        }}
      >
        <UserArrowRight className="size-4" aria-hidden="true" />
        {t('signOut')}
      </button>
    </>
  );
}

/**
 * The same rows at the foot of the phone drawer, as vendored `NavItem`s under
 * an "Акаунт" heading, so they read as the drawer's own rows. Sign-out is a
 * `NavItem` with no `href`: upstream's action row, a real `<button>`.
 */
export function DrawerAccountSection({
  links,
  onNavigate,
}: {
  links: AccountLinks;
  onNavigate: () => void;
}) {
  const t = useTranslations('common');
  const tNav = useTranslations('common.nav');
  return (
    <div className="border-border-subtle mt-2 border-t p-2" data-testid="drawer-account">
      <NavSection title={tNav('account')}>
        {useRows(links).map((row) => (
          <NavItem
            key={row.key}
            href={row.href}
            prefetch="auto"
            icon={row.icon}
            label={row.label}
            active={false}
            onClick={onNavigate}
          />
        ))}
        <NavItem
          prefetch="auto"
          icon={UserArrowRight}
          label={t('signOut')}
          active={false}
          onClick={() => {
            onNavigate();
            signOutHome();
          }}
        />
      </NavSection>
    </div>
  );
}
