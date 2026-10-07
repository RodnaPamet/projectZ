'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { ArrowUpRight } from '@/components/ui/icons/nucleo';

import { AccountMenuRows } from './account-links';
import { NavBar, NavBarMobileMenu } from './nav-bar';
import { SIGNED_IN_HOME, type AccountLinks } from './nav-items';
import { UserMenu } from './user-menu';

/**
 * Every shell's top bar, on upstream's vendored `NavBar` slots (#362).
 *
 *   left   the 44 px hamburger (phones only) · the playerz.bg wordmark
 *   right  club admin, platform: from `sm` the public site ↗ · the club's (or
 *            the platform's) name · the account menu
 *          player: the bell (`actions`) · from `md` the account menu
 *
 * ═══ NO SWITCHER (#263) ═══
 *
 * A CLUB account holds exactly one club, so the name on the right is not a
 * picker. Upstream's tenant switcher has nothing to switch here and is not
 * vendored.
 *
 * ═══ THE WAY OUT (#347) ═══
 *
 * The wordmark leaves the shell for the site: Играй (`SIGNED_IN_HOME`), which
 * is where `/` sends anybody signed in, linked directly rather than through
 * that redirect. The club's (or platform's) name is the link back to the
 * shell's own start instead. And from `sm` the public page is named outright,
 * "Публична страница ↗"; on a phone that row is in the drawer.
 *
 * ═══ THE WORDMARK, NOT `NavBarBrand` ═══
 *
 * `NavBarBrand` paints initials on a pulsing brand-gradient tile. playerz's
 * header shows the name, in charcoal (`text-content-emphasis`, 15.56:1 light
 * and 17.06:1 dark), and the owner kept it so; `SiteHeader.tsx` explains why
 * no brand shade can carry 16 px text in both themes.
 *
 * ═══ THE ACCOUNT MENU ═══
 *
 * The vendored `UserMenu` brings the identity header and the theme row. Its
 * language row is off (`showLanguage={false}`, upstream #3100): the language
 * is the user's, kept on `/me/profile`, where the switcher writes the record
 * first. The account rows arrive through the `items` slot. A player's menu is
 * there from `md` only (`menuFromMd`): below it the Профил tab is the
 * account's place, and the profile page holds the theme and sign-out, so
 * neither control is on a phone screen twice.
 */
export function ShellTopBar({
  context,
  actions,
  user,
  account,
  menuFromMd = false,
  onMobileMenuClick,
}: {
  /** The club's (or the platform's) name, linking back to the shell's own start. */
  context?: { name: string; href: string };
  /** Icons before the account menu: the player's bell. */
  actions?: ReactNode;
  user: { name: string | null; email: string | null };
  account: AccountLinks;
  /** Show the account menu from `md` only. */
  menuFromMd?: boolean;
  onMobileMenuClick: () => void;
}) {
  const t = useTranslations('common');
  const tNav = useTranslations('nav');

  const menu = (
    <UserMenu
      displayName={user.name ?? user.email}
      displayEmail={user.email}
      displayImage={null}
      showLanguage={false}
      items={({ close }) => <AccountMenuRows links={account} close={close} />}
    />
  );

  return (
    <NavBar
      left={
        <>
          <NavBarMobileMenu onClick={onMobileMenuClick} />
          <Link
            href={SIGNED_IN_HOME}
            aria-label={tNav('brandHome')}
            className="text-content-emphasis rounded-sm font-semibold focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
            data-testid="shell-wordmark"
          >
            {t('appName')}
          </Link>
        </>
      }
      right={
        <>
          {account.publicSite ? (
            <Link
              href={account.publicSite.href}
              className="text-content-default hidden items-center gap-1 text-sm whitespace-nowrap underline-offset-4 hover:underline sm:inline-flex"
              data-testid="shell-public-link"
            >
              {account.publicSite.label}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
          {context ? (
            <Link
              href={context.href}
              className="text-content-muted hover:text-content-default max-w-[8rem] truncate text-sm underline-offset-4 hover:underline sm:max-w-[16rem]"
              data-testid="shell-context-name"
            >
              {context.name}
            </Link>
          ) : null}
          {actions}
          {menuFromMd ? <div className="hidden md:flex">{menu}</div> : menu}
        </>
      }
    />
  );
}
