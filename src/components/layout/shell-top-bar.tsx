'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ArrowUpRight } from '@/components/ui/icons/nucleo';
import { persistMyLocale } from '@/lib/i18n/persist-my-locale';

import { AccountMenuRows } from './account-links';
import { HeaderActions } from './header-actions';
import { NavBar, NavBarMobileMenu } from './nav-bar';
import { SIGNED_IN_HOME, type ShellAccount } from './nav-items';
import { UserMenu } from './user-menu';

/**
 * Every shell's top bar, on upstream's vendored `NavBar` slots (#362).
 *
 *   left   the 44 px hamburger (phones only) · the playerz.bg wordmark
 *   right  club admin, platform: from `sm` the public site ↗ · the club's (or
 *            the platform's) name
 *          every shell: the bell (#367), then the account menu
 *
 * The right slot ends as upstream's `TopChrome` does (owner, 2026-10-08):
 * `NotificationsBell`, then `UserMenu`, at every width and in every shell.
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
 * ═══ THE ACCOUNT MENU, THE SAME IN EVERY SHELL ═══
 *
 * The vendored `UserMenu` as upstream builds it: the name and e-mail, Тема,
 * Език, then the account's rows through its `items` slot, Профил and Изход.
 * The language lives on the user record, re-seeded into the cookie on every
 * request, so the language row writes the record first (`persistMyLocale`,
 * handed to the row's switcher through `onLocaleChange`, upstream #3248); a
 * switch the record refuses is abandoned and the old language stays.
 */
export function ShellTopBar({
  context,
  user,
  account,
  onMobileMenuClick,
}: {
  /** The club's (or the platform's) name, linking back to the shell's own start. */
  context?: { name: string; href: string };
  user: { userId: string; name: string | null; email: string | null };
  account: Pick<ShellAccount, 'publicSite'>;
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
          <HeaderActions viewerId={user.userId} />
          <UserMenu
            displayName={user.name ?? user.email}
            displayEmail={user.email}
            displayImage={null}
            onLocaleChange={persistMyLocale}
            items={({ close }) => <AccountMenuRows close={close} />}
          />
        </>
      }
    />
  );
}
