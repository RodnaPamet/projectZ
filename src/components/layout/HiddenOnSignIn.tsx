'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Renders its children everywhere except on the sign-in page (#319, audit A05).
 *
 * /login sits in the `(public)` layout, so the site header renders there for a
 * signed-out visitor, and its "Вход" button pointed at /login itself: a link
 * to the page you are on. The header is a Server Component and does not know
 * the path, so this client wrapper asks the router, the way `BottomTabBar`
 * hides itself on the same page.
 */
export function HiddenOnSignIn({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return /^\/login(?:\/|$)/.test(pathname ?? '') ? null : children;
}
