'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { ArrowUpRight } from '@/components/ui/icons/nucleo';
import { persistMyLocale } from '@/lib/i18n/persist-my-locale';

import { AccountMenuRows } from './account-links';
import { useCurrentBreadcrumbs } from './breadcrumbs-store';
import { HeaderActions, type HeaderMessages } from './header-actions';
import { NavBar, NavBarMobileMenu } from './nav-bar';
import { SIGNED_IN_HOME, type ShellAccount } from './nav-items';
import { UserMenu } from './user-menu';

/**
 * Every shell's top bar, on upstream's vendored `NavBar` slots (#362).
 *
 *   left   below `md`: the 44 px hamburger · the playerz.bg wordmark
 *          from `md`: the page's breadcrumbs
 *   right  club admin, platform: from `sm` the public site ↗ · the club's (or
 *            the platform's) name
 *          every shell: the bell (#367), then the account menu
 *
 * Both slots are upstream's `TopChrome` (owner, 2026-10-08). The right one
 * ends with `NotificationsBell`, then `UserMenu`, at every width and in every
 * shell. The left one carries the trail the page pushed into the shell's
 * `BreadcrumbsProvider` (`useCurrentBreadcrumbs`, the vendored `Breadcrumbs`),
 * hidden below `md` where the page draws it inline (`PageBreadcrumbs`), with
 * a screen-reader sentinel until a page has pushed one, so the bar keeps its
 * height. From `md` the sidebar's header already names the app (or the club,
 * or the platform), so the bar shows the wordmark below `md` only, and never
 * says it twice.
 *
 * ═══ NOTHING UNDER THE RIGHT SLOT ═══
 *
 * Upstream's right slot never shrinks (`NAV_BAR_SLOT_RIGHT`); the left one
 * gives way, and what does not fit in it runs on underneath. So the club's
 * name covered the wordmark on a phone, by 25 px at 393 px with a sixteen-
 * letter name, and at 768 px a long name left the trail running 69 px under
 * the public link. Below `sm`, where the bell and the menu are 44 px targets,
 * the club's (or the platform's) name leaves the bar, as upstream's switcher
 * does (its `hidden sm:inline-flex`; `sm:block` here, so `truncate` keeps its
 * ellipsis), and heads the drawer instead; until `lg` it is capped at 10rem.
 * And the trail and its `nav` are `min-w-0`, so the vendored `Breadcrumbs`
 * wraps and then truncates its crumbs, as its own `min-w-0` rows mean it to,
 * rather than overflowing.
 *
 * ═══ NO SWITCHER (#263) ═══
 *
 * A CLUB account holds exactly one club, so the name on the right is not a
 * picker. Upstream's tenant switcher has nothing to switch here and is not
 * vendored.
 *
 * ═══ THE WAY OUT (#347) ═══
 *
 * On a phone the wordmark leaves the shell for the site: Играй
 * (`SIGNED_IN_HOME`), which is where `/` sends anybody signed in, linked
 * directly rather than through that redirect; from `md` a player's trail
 * starts at Играй. The club's (or platform's) name is the link back to the
 * shell's own start instead. And from `sm` the public page is named outright,
 * "Публична страница ↗"; on a phone that row is in the drawer.
 *
 * ═══ THE WORDMARK, NOT `NavBarBrand` ═══
 *
 * `NavBarBrand` paints initials on a pulsing brand-gradient tile. playerz's
 * header shows the name, in charcoal (`text-content-emphasis`, 15.56:1 light
 * and 17.79:1 dark), and the owner kept it so; `SiteHeader.tsx` explains why
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
  messages = null,
  onMobileMenuClick,
}: {
  /** The club's (or the platform's) name, linking back to the shell's own start. */
  context?: { name: string; href: string };
  user: { userId: string; name: string | null; email: string | null };
  account: Pick<ShellAccount, 'publicSite'>;
  /** The messages icon's inbox (#375), or null while the module is off. */
  messages?: HeaderMessages | null;
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
            className="text-content-emphasis rounded-sm font-semibold focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none md:hidden"
            data-testid="shell-wordmark"
          >
            {t('appName')}
          </Link>
          <TopBarTrail />
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
              className="text-content-muted hover:text-content-default hidden max-w-[10rem] truncate text-sm underline-offset-4 hover:underline sm:block lg:max-w-[16rem]"
              data-testid="shell-context-name"
            >
              {context.name}
            </Link>
          ) : null}
          <HeaderActions viewerId={user.userId} messages={messages} />
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

/**
 * The left slot's trail from `md`, as upstream's `TopChrome` draws it: the
 * vendored `Breadcrumbs` over whatever the page pushed, or a screen-reader
 * sentinel until it has, so the bar keeps its height.
 *
 * Its own component, and the bar's only reader of the trail: a page pushes
 * after it mounts, and only this re-renders then, not the bell or the account
 * menu beside it. `min-w-0` on the wrapper and the `nav` is the one departure
 * from upstream's markup: it lets the trail give way to the right slot (see
 * NOTHING UNDER THE RIGHT SLOT above).
 */
function TopBarTrail() {
  const tNav = useTranslations('nav');
  const breadcrumbs = useCurrentBreadcrumbs();
  return (
    <span className="hidden min-w-0 items-center md:inline-flex">
      {breadcrumbs.length > 0 ? (
        <Breadcrumbs items={breadcrumbs} className="min-w-0" data-testid="top-chrome-breadcrumbs" />
      ) : (
        <span className="sr-only">{tNav('noBreadcrumbs')}</span>
      )}
    </span>
  );
}
