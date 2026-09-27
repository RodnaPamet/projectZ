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
  const tLogin = await getTranslations('login');

  return (
    <header className="border-border-subtle flex items-center justify-between gap-4 border-b px-4 py-3">
      <Link href="/" className="text-brand-600 font-semibold">
        {t('appName')}
      </Link>

      <nav className="flex items-center gap-4">
        {me ? (
          <>
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
