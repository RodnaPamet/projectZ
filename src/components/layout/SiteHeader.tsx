import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

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
 * matters here, where one identity can hold several clubs.
 */
export async function SiteHeader() {
  const [t, me] = await Promise.all([getTranslations('common'), signedInIdentity()]);
  const [tLogin, tMine] = await Promise.all([
    getTranslations('login'),
    getTranslations('myBookings'),
  ]);

  return (
    <header className="border-border-subtle flex items-center justify-between gap-4 border-b px-4 py-3">
      {/*
        NOT `text-brand-600`. That is a FILL colour — `--brand-emphasis`, whose
        own comment measures it "5.1:1 on white" — and the page background is
        #f4f2ed, not white, where it is 4.48:1. At 36px on the homepage that
        passes, because large text only needs 3:1. At 16px in a header it needs
        4.5:1 and misses, which axe caught as a serious violation.

        No fixed brand shade would fix it: brand-600 fails BOTH themes as body
        text (4.48 light, 3.79 dark), brand-500 passes only dark and brand-700
        only light. A `dark:` variant would not help either — Tailwind defaults
        to the `media` strategy here, so it keys off the OS preference while
        this app switches themes with [data-theme].

        `content-emphasis` is the headings token and is theme-aware by
        construction: 15.56:1 light, 17.06:1 dark — measured with src/lib/design/contrast.ts.
      */}
      <Link href="/" className="text-content-emphasis font-semibold">
        {t('appName')}
      </Link>

      <nav className="flex items-center gap-4">
        {me ? (
          <>
            {/* email as the fallback, never a blank space: an OAuth profile
                with no name is ordinary, and an empty greeting looks broken. */}
            {/*
              The link that makes /me/bookings reachable. Without it the page
              exists and nothing points at it — which is the exact failure
              #224 is about: /login worked perfectly for weeks and the only
              reference to it anywhere in src/ was the invite page.
            */}
            <Link href="/me/bookings" className="text-sm underline-offset-4 hover:underline">
              {tMine('title')}
            </Link>
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
