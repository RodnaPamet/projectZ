import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { SignOutButton } from '@/components/layout/SignOutButton';
import { signedInIdentity } from '@/lib/auth/page-context';

/**
 * The public site header.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Signing in used to change nothing you could see. The homepage read no
 * session, so a successful Google round trip landed you back on an identical
 * page — reported twice as "I logged in and came back to the same screen".
 * The first time that was a real bug (#223); the second time the sign-in had
 * worked perfectly and there was simply nothing that said so.
 *
 * An app that cannot tell you whether you are signed in has no observable
 * difference between working and broken.
 *
 * It renders the person's NAME, not a generic "Account". Which account you are
 * in is the thing people actually need from a header, and it is the difference
 * between "am I signed in?" and "am I signed in AS THE RIGHT ONE?" — which
 * matters more since #263, when one person may well hold a player account and
 * a club account, and sign into the wrong one.
 *
 * ═══ AND THE WAY BACK TO YOUR CLUB (#263) ═══
 *
 * It used to carry #227's role switcher, for somebody holding several
 * contexts: player, plus each club they ran. One account is one kind now, so
 * there is nothing to switch — but a club account browsing the venues still
 * needs a way back to its club without signing in again. So the link that
 * says "My bookings" to a player names the club to a club account, and points
 * where `/start` would land it. Read from the database, not the token: the
 * token has neither club names nor club status.
 */
export async function SiteHeader() {
  const [t, me] = await Promise.all([getTranslations('common'), signedInIdentity()]);
  const [tLogin, tMine, landing] = await Promise.all([
    getTranslations('login'),
    getTranslations('myBookings'),
    me ? resolveLanding(me.userId) : Promise.resolve(null),
  ]);

  return (
    // ═══ IT WRAPS ON A PHONE, RATHER THAN RUNNING OFF THE SIDE ═══
    //
    // One row that cannot shrink is a page that scrolls sideways. Measured in
    // Chromium before this wrapped: 42px of sideways scroll on a 375px phone
    // for a signed-in player, and 75–157px once the role switcher joined the
    // row — with sign-out the thing pushed off the edge. Wrapping costs a
    // second row on a phone and nothing on anything wider.
    <header className="border-border-subtle flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
      {/*
        NOT `text-brand-600`. That is a FILL colour — `--brand-emphasis`, whose
        comment used to measure it "5.1:1 on white" — and the page background
        is #f4f2ed, not white, where it is 4.48:1. At 36px that passes, because
        large text only needs 3:1. At 16px in a header it needs 4.5:1 and
        misses, which axe caught as a serious violation (#233).

        No fixed brand shade would fix it: brand-600 fails BOTH themes as body
        text (4.48 light, 3.79 dark), brand-500 passes only dark and brand-700
        only light, and tests/guardrails/no-raw-brand-text.test.ts now bans them
        as text. A `dark:` variant would not help either — Tailwind defaults
        to the `media` strategy here, so it keys off the OS preference while
        this app switches themes with [data-theme].

        `content-emphasis` is the headings token and is theme-aware by
        construction: 15.56:1 light, 17.06:1 dark — measured with src/lib/design/contrast.ts.
        If the wordmark should be green, `text-content-brand` is the token for
        green text: 6.37:1 light, 5.77:1 dark.
      */}
      <Link href="/" className="text-content-emphasis font-semibold">
        {t('appName')}
      </Link>

      <nav className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        {me ? (
          <>
            {landing?.club ? (
              // A club account's way back to its club: the club's name, to
              // where `/start` lands it. `max-w` + truncate, because club
              // names are long and this row must not scroll sideways.
              <Link
                href={landing.href}
                className="max-w-[14rem] truncate text-sm underline-offset-4 hover:underline"
              >
                {landing.club.tenantName}
              </Link>
            ) : landing?.reason === 'club-unavailable' ? null : (
              /*
                The link that makes /me/bookings reachable. Without it the page
                exists and nothing points at it — which is the exact failure
                #224 is about: /login worked perfectly for weeks and the only
                reference to it anywhere in src/ was the invite page.
              */
              <Link
                href="/me/bookings"
                // One line: squeezed, it broke into two mid-label before the
                // row gave up and wrapped.
                className="text-sm whitespace-nowrap underline-offset-4 hover:underline"
              >
                {tMine('title')}
              </Link>
            )}
            {/* email as the fallback, never a blank space: an OAuth profile
                with no name is ordinary, and an empty greeting looks broken. */}
            <span className="text-content-muted max-w-[12rem] truncate text-sm">
              {me.name ?? me.email}
            </span>
            <SignOutButton />
          </>
        ) : (
          <Link
            href="/login"
            className="border-border-default inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium"
          >
            {tLogin('title')}
          </Link>
        )}
      </nav>
    </header>
  );
}
