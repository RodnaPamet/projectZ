import type { ReactNode } from 'react';

import { BottomTabBar } from './BottomTabBar';
import { playerChrome, SiteHeader } from './SiteHeader';
import { SiteFooter } from './site-footer';

/**
 * The player chrome around a page (T20, #362): the site header, the page, and
 * the bottom tab bar below `md`.
 *
 * Rendered by `src/app/(public)/layout.tsx` and `src/app/(app)/me/layout.tsx`,
 * so a tab tap between /venues, /me/bookings and /me/profile keeps the chrome
 * mounted, and by the home page itself: `/` sits in the `(home)` group beside
 * a loading.tsx that already draws a header skeleton.
 *
 * A column at least one screen tall, so a page's `<main>` can take `flex-1`
 * and centre itself in what the header and the tab bar leave, rather than
 * subtracting a header height that is a guess (it was 3.5rem; the vendored
 * NavBar is 4rem plus the notch).
 *
 * `footer` adds the public footer (#368, #369) with the language switch a
 * signed-out visitor can reach: on the public pages, the landing page and the
 * 404, not on /me, where the profile carries its own switch (#362).
 */
export async function PlayerChrome({
  children,
  footer = false,
}: {
  children: ReactNode;
  footer?: boolean;
}) {
  const { me, kind, modules, account } = await playerChrome();

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      {children}
      {footer ? <SiteFooter signedIn={me !== null} /> : null}
      <BottomTabBar kind={kind} modules={modules} adminHref={account?.clubAdmin?.href ?? null} />
    </div>
  );
}
