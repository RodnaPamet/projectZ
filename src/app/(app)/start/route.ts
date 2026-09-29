import { redirect } from 'next/navigation';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { requireSignedIn } from '@/lib/auth/page-context';

/**
 * GET /start — the post-sign-in router (#227).
 *
 * `/login` hands this path to next-auth as the `callbackUrl` whenever the
 * visitor brought no destination of their own, so a successful Google or
 * Microsoft round trip ends here and is sent on by role: the player UI, the
 * club UI, or wherever they last chose to be. The rule is `decideLanding` in
 * `@/lib/auth/landing`; this file only asks and redirects.
 *
 * ═══ A ROUTE HANDLER, NOT A PAGE ═══
 *
 * It has nothing to render, ever. As a page it would run the root layout —
 * locale, message catalogue, theme — to produce a redirect. A handler answers
 * with the 307 and nothing else.
 *
 * ═══ GET, AND SIDE-EFFECT FREE ═══
 *
 * It only reads. Recording where someone went is the switcher's job and
 * happens on a POST, because a GET that wrote would be triggered by link
 * prefetching — a hover could rewrite where somebody lands tomorrow.
 *
 * ═══ NOT SIGNED IN ═══
 *
 * Back to /login with no `next`, since landing IS the default there. That
 * includes a token that still verifies but whose session was revoked:
 * `requireSignedIn` runs `checkSession`, so "sign out everywhere" reaches this
 * route like any other.
 */
export async function GET(): Promise<never> {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login');

  const { context } = await resolveLanding(userId);
  redirect(context.href);
}
