import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { HiddenOnSignIn } from '@/components/layout/HiddenOnSignIn';
import { NavBar } from '@/components/layout/nav-bar';
import { PUBLIC_HEADER_LINKS } from '@/components/layout/nav-items';
import { PublicPrefetchLink } from '@/components/layout/PublicPrefetchLink';

/**
 * The public site's header, for a visitor who is NOT signed in (T20, #362),
 * on upstream's vendored `NavBar` slots:
 *
 *   left   the charcoal wordmark · from md, Играй
 *   right  from md, Вход (not on /login itself)
 *
 * Below `md` the bottom tab bar carries Играй and Вход, so the header there is
 * the wordmark alone.
 *
 * ═══ SIGNED IN, THERE IS NO HEADER LIKE THIS (#362, owner 2026-10-07) ═══
 *
 * A signed-in account wears upstream's AppShell on every page instead: a
 * player its own sidebar (`PlayerShell`), a club account its club admin's
 * (`ClubAdminShell`). `PlayerChrome` decides which on the server, so signing
 * in changes the whole frame, never just a corner of this bar. That is also
 * the answer to the report this header once existed for: "I logged in and
 * came back to the same screen" (#223).
 */
export function SiteHeader() {
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
            {PUBLIC_HEADER_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-content-default text-sm whitespace-nowrap underline-offset-4 hover:underline"
              >
                {tNav(l.labelKey)}
              </Link>
            ))}
          </nav>
        </>
      }
      right={
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
      }
    />
  );
}
