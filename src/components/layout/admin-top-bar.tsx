'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';

import { UserArrowRight } from '@/components/ui/icons/nucleo';

import { NavBar, NavBarMobileMenu } from './nav-bar';
import { USER_MENU_ROW_CLASS, UserMenu } from './user-menu';

/**
 * The admin shell's top bar, on inflect's vendored `NavBar` slots.
 *
 *   left   the 44 px hamburger (phones only) · the playerz.bg wordmark
 *   right  the club's (or the platform's) name · the account menu
 *
 * ═══ NO SWITCHER (#263) ═══
 *
 * A CLUB account holds exactly one club, so the name on the right is a
 * static label, not a picker. inflect's tenant switcher has nothing to switch
 * here and is not vendored.
 *
 * ═══ THE WORDMARK, NOT `NavBarBrand` ═══
 *
 * `NavBarBrand` paints initials on a pulsing brand-gradient tile. playerz's
 * header shows the name, in charcoal (`text-content-emphasis`, 15.56:1 light
 * and 17.06:1 dark), and the owner kept it so; `SiteHeader.tsx` explains why
 * no brand shade can carry 16 px text in both themes. It links to the club's
 * front door, which sends staff to the diary.
 *
 * ═══ THE ACCOUNT MENU ═══
 *
 * The vendored `UserMenu` brings the identity header and the theme row. Its
 * language row is off (`showLanguage={false}`, inflect #3100): the middleware
 * re-seeds the locale cookie from `User.locale` on every signed-in request, so
 * a cookie-only switch would flip the page and flip it straight back. Sign-out
 * arrives through the `items` slot, because the menu no longer imports an auth
 * library; it lands on the homepage, as the player header's does.
 */
export function AdminTopBar({
  homeHref,
  contextName,
  user,
  onMobileMenuClick,
}: {
  homeHref: string;
  contextName: string;
  user: { name: string | null; email: string | null };
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
            href={homeHref}
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
          <span
            className="text-content-muted max-w-[8rem] truncate text-sm sm:max-w-[16rem]"
            data-testid="admin-context-name"
          >
            {contextName}
          </span>
          <UserMenu
            displayName={user.name}
            displayEmail={user.email}
            displayImage={null}
            showLanguage={false}
            items={({ close }) => (
              <button
                type="button"
                className={USER_MENU_ROW_CLASS}
                data-testid="user-menu-sign-out"
                onClick={() => {
                  close();
                  void signOut({ callbackUrl: '/' });
                }}
              >
                <UserArrowRight className="size-4" aria-hidden="true" />
                {t('signOut')}
              </button>
            )}
          />
        </>
      }
    />
  );
}
