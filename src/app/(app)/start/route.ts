import { redirect } from 'next/navigation';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { requireSignedIn } from '@/lib/auth/page-context';

/**
 * GET /start — the post-sign-in router (#227, by account kind since #263).
 *
 * `/login` hands this path to next-auth as the `callbackUrl` whenever the
 * visitor brought no destination of their own, so a successful Google or
 * Microsoft round trip ends here and is sent on by the KIND of account: a
 * player to the player UI, a club account to its one club's diary, a coach to
 * the coach UI (the player UI until there is one). The rule is `decideLanding`
 * in `@/lib/auth/landing`; this file only asks and redirects.
 *
 * A deep link never reaches here: `/login` sends `?next=` straight back to
 * where the visitor was going, after `safeCallbackPath` has made sure it is a
 * path on this site.
 *
 * ═══ A ROUTE HANDLER, NOT A PAGE ═══
 *
 * It has nothing to render, ever. As a page it would run the root layout —
 * locale, message catalogue, theme — to produce a redirect. A handler answers
 * with the 307 and nothing else.
 *
 * ═══ GET, AND SIDE-EFFECT FREE ═══
 *
 * It only reads. It used to be the reader of a "last used" choice the role
 * switcher wrote; with one kind per account there is no choice to remember,
 * and the switcher and the column are gone.
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

  const { href } = await resolveLanding(userId);
  redirect(href);
}
