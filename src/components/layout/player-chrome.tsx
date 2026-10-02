import type { ReactNode } from 'react';

import { BottomTabBar } from './BottomTabBar';
import { playerChrome, SiteHeader } from './SiteHeader';

/**
 * The player chrome around a page (T20): the site header, the page, and the
 * bottom tab bar below `md`.
 *
 * Rendered by `src/app/(public)/layout.tsx` and `src/app/(app)/me/layout.tsx`,
 * so a tab tap between /venues and /me/bookings keeps the chrome mounted, and
 * by the home page itself: `/` sits in the `(home)` group beside a loading.tsx
 * that already draws a header skeleton.
 *
 * A column at least one screen tall, so a page's `<main>` can take `flex-1`
 * and centre itself in what the header and the tab bar leave, rather than
 * subtracting a header height that is a guess (it was 3.5rem; the vendored
 * NavBar is 4rem plus the notch).
 */
export async function PlayerChrome({ children }: { children: ReactNode }) {
  const { me, kind } = await playerChrome();

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      {children}
      <BottomTabBar kind={kind} identity={me ? { name: me.name, email: me.email } : null} />
    </div>
  );
}
