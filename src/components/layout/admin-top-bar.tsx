'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ArrowUpRight } from '@/components/ui/icons/nucleo';

import { AccountMenuRows, type AccountLinks } from './account-links';
import { NavBar, NavBarMobileMenu } from './nav-bar';
import { UserMenu } from './user-menu';

/**
 * The admin shell's top bar, on upstream's vendored `NavBar` slots.
 *
 *   left   the 44 px hamburger (phones only) · the playerz.bg wordmark
 *   right  from `sm`, the public site ↗ · the club's (or the platform's)
 *          name · the account menu
 *
 * ═══ NO SWITCHER (#263) ═══
 *
 * A CLUB account holds exactly one club, so the name on the right is not a
 * picker. Upstream's tenant switcher has nothing to switch here and is not
 * vendored.
 *
 * ═══ THE WAY OUT (#347) ═══
 *
 * The wordmark used to lead to the club's front door, which redirects to the
 * diary, so clicking it never left the shell. It now goes to `/`, the public
 * home page, as its label ("playerz.bg — към началото") always said. The
 * club's (or platform's) name is the link back to the shell's own start
 * instead. And from `sm` the public site is named outright, "Публична
 * страница ↗"; on a phone that row is in the drawer, behind "Още".
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
 * first. The account rows (the public site, the profile, the platform for a
 * grant holder) and sign-out arrive through the `items` slot.
 */
export function AdminTopBar({
  homeHref,
  contextName,
  user,
  account,
  onMobileMenuClick,
}: {
  homeHref: string;
  contextName: string;
  user: { name: string | null; email: string | null };
  account: AccountLinks;
  onMobileMenuClick: () => void;
}) {
  const t = useTranslations('common');
  const tNav = useTranslations('nav');

  return (
    <NavBar
      left={
        <>
          <NavBarMobileMenu onClick={onMobileMenuClick} />
          <Link
            href="/"
            aria-label={tNav('brandHome')}
            className="text-content-emphasis rounded-sm font-semibold focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
            data-testid="admin-wordmark"
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
              data-testid="admin-public-link"
            >
              {account.publicSite.label}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
          <Link
            href={homeHref}
            className="text-content-muted hover:text-content-default max-w-[8rem] truncate text-sm underline-offset-4 hover:underline sm:max-w-[16rem]"
            data-testid="admin-context-name"
          >
            {contextName}
          </Link>
          <UserMenu
            displayName={user.name}
            displayEmail={user.email}
            displayImage={null}
            showLanguage={false}
            items={({ close }) => <AccountMenuRows links={account} close={close} />}
          />
        </>
      }
    />
  );
}
