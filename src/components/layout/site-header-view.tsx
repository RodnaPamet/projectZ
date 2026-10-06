import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { AccountLinks } from '@/components/layout/account-links';
import { HeaderActions } from '@/components/layout/header-actions';
import { HiddenOnSignIn } from '@/components/layout/HiddenOnSignIn';
import { NavBar } from '@/components/layout/nav-bar';
import { PlayerUserMenu } from '@/components/layout/player-user-menu';
import { PublicPrefetchLink } from '@/components/layout/PublicPrefetchLink';
import { buttonVariants } from '@/components/ui/button-variants';
import { ArrowLeft } from '@/components/ui/icons/nucleo';

/**
 * The public site header itself, from plain data (#362). `SiteHeader` reads
 * the session and hands it this; split out so a rendered test can draw every
 * account kind's header without a session.
 */
export function SiteHeaderView({
  links,
  identity,
  account,
  messaging,
}: {
  links: { href: string; label: string }[];
  identity: { name: string | null; email: string | null } | null;
  /** The account rows, decided on the server; `null` when signed out. */
  account: AccountLinks | null;
  /** `modules.messaging`: the messages icon waits for module 1 (#375). */
  messaging: boolean;
}) {
  const t = useTranslations('common');
  const tNav = useTranslations('common.nav');
  const tUi = useTranslations('common.ui');
  const tLogin = useTranslations('login');

  return (
    <NavBar
      left={
        <>
          {/*
            NOT `text-brand-600`. That is a FILL colour — `--brand-emphasis` —
            and on the #f4f2ed page it is 4.48:1, which passes as 36px text
            but misses 4.5:1 at 16px; axe caught it as a serious violation
            (#233). No fixed brand shade passes as text in both themes, and
            tests/guardrails/no-raw-brand-text.test.ts bans them as text.
            `content-emphasis` is the headings token, theme-aware by
            construction: 15.56:1 light, 17.06:1 dark (src/lib/design/contrast.ts).
            The owner kept the wordmark charcoal.
          */}
          <Link
            href="/"
            className="text-content-emphasis shrink-0 rounded-sm font-semibold focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
          >
            {t('appName')}
          </Link>

          {/* From md. Below it these are tabs, and two rows of the same
              links on one phone screen is one too many. Default (auto)
              prefetch: docs/perf/navigation-policy.md keeps full prefetch to
              the tab bar. */}
          <nav aria-label={tUi('mainNav')} className="hidden min-w-0 items-center gap-4 md:flex">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-content-default text-sm whitespace-nowrap underline-offset-4 hover:underline"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </>
      }
      right={
        identity && account ? (
          <>
            {account.clubAdmin ? (
              // A club account's way back to its admin, at every width (#346):
              // the primary button's own recipe, so it reads as the control it
              // is. Default (auto) prefetch: it opens the live diary.
              <Link
                href={account.clubAdmin.href}
                className={buttonVariants({ variant: 'primary' })}
                data-testid="site-header-admin"
              >
                <ArrowLeft aria-hidden="true" />
                {tNav('backToAdmin')}
              </Link>
            ) : null}
            <HeaderActions messaging={messaging} />
            <div className="hidden md:flex">
              <PlayerUserMenu name={identity.name} email={identity.email} links={account} />
            </div>
          </>
        ) : (
          // Fully prefetched (#290): anonymous only, the same 1.4 KB for
          // everyone, and the first visit then skips the reveal throttle.
          // From md; below it the tab bar's Sign in tab is the same link.
          // Not on /login itself, where it would link to the page (#319).
          <HiddenOnSignIn>
            <PublicPrefetchLink
              href="/login"
              className="border-border-default hidden h-9 items-center rounded-md border px-3 text-sm font-medium md:inline-flex"
            >
              {tLogin('title')}
            </PublicPrefetchLink>
          </HiddenOnSignIn>
        )
      }
    />
  );
}
