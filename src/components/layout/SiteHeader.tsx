import { cache } from 'react';

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { playerChromeKind, playerTopLinks } from '@/components/layout/nav-items';
import { NavBar } from '@/components/layout/nav-bar';
import { PlayerUserMenu } from '@/components/layout/player-user-menu';
import { PublicPrefetchLink } from '@/components/layout/PublicPrefetchLink';
import { signedInIdentity } from '@/lib/auth/page-context';

/**
 * Who the player chrome is for, read once per request.
 *
 * The header and the bottom tab bar both need it (T20), and a layout cannot
 * pass props to a page, so it is `cache`d like `signedInIdentity` beneath it:
 * the session check and the landing read run once however many pieces of
 * chrome ask. `resolveLanding` is read from the database, not the token: the
 * token has neither club names nor club status.
 */
export const playerChrome = cache(async () => {
  const me = await signedInIdentity();
  const landing = me ? await resolveLanding(me.userId) : null;
  return { me, landing, kind: playerChromeKind(me !== null, landing?.reason) };
});

/**
 * The public site header, on upstream's vendored `NavBar` slots (T20).
 *
 *   left   the charcoal wordmark · from md, Discover and (for a player) My bookings
 *   right  a CLUB account's link to its club · from md, the account menu or Sign in
 *
 * Below `md` the bottom tab bar (`BottomTabBar.tsx`) carries the links, the
 * Sign in and the account menu, so the header there is the wordmark alone —
 * plus, for a CLUB account, its club.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Signing in used to change nothing you could see. The homepage read no
 * session, so a successful Google round trip landed you back on an identical
 * page — reported twice as "I logged in and came back to the same screen".
 * The first time that was a real bug (#223); the second time the sign-in had
 * worked perfectly and there was simply nothing that said so. An app that
 * cannot tell you whether you are signed in has no observable difference
 * between working and broken. The account menu's trigger and its header name
 * the person, not a generic "Account": since #263 one person may well hold a
 * player account and a club account, and sign into the wrong one.
 *
 * ═══ AND THE WAY BACK TO YOUR CLUB (#263) ═══
 *
 * One account is one kind, so there is no switcher. A club account browsing
 * the venues still needs a way back to its club without signing in again, so
 * it gets a link naming the club, to where `/start` would land it, at every
 * width. It is the only club reference in the player chrome: a PLAYER account
 * sees none.
 */
export async function SiteHeader() {
  const [t, tNav, tUi, tLogin, { me, landing, kind }] = await Promise.all([
    getTranslations('common'),
    getTranslations('common.nav'),
    getTranslations('common.ui'),
    getTranslations('login'),
    playerChrome(),
  ]);
  const links = playerTopLinks(kind);

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
                {tNav(l.labelKey)}
              </Link>
            ))}
          </nav>
        </>
      }
      right={
        me ? (
          <>
            {landing?.club ? (
              // A club account's way back to its club, at every width:
              // the club's name, to where `/start` lands it. `max-w` +
              // truncate, because club names are long and this row must not
              // push the page sideways on a 375 px phone.
              <Link
                href={landing.href}
                className="text-content-default max-w-[10rem] truncate text-sm underline-offset-4 hover:underline sm:max-w-[16rem]"
                data-testid="site-header-club"
              >
                {landing.club.tenantName}
              </Link>
            ) : null}
            <div className="hidden md:flex">
              <PlayerUserMenu name={me.name} email={me.email} />
            </div>
          </>
        ) : (
          // Fully prefetched (#290): anonymous only, the same 1.4 KB for
          // everyone, and the first visit then skips the reveal throttle.
          // From md; below it the tab bar's Sign in tab is the same link.
          <PublicPrefetchLink
            href="/login"
            className="border-border-default hidden h-9 items-center rounded-md border px-3 text-sm font-medium md:inline-flex"
          >
            {tLogin('title')}
          </PublicPrefetchLink>
        )
      }
    />
  );
}
