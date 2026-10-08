import { cache } from 'react';

import { unstable_rethrow } from 'next/navigation';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { signedInIdentity } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';
import { readModules } from '@/lib/modules';
import { logger } from '@/lib/observability/logger';

import { playerChromeKind, PLATFORM_HREF } from './nav-items';

/*
 * The chrome's READS, apart from the chrome (#362). `player-chrome.tsx` draws
 * the frames and imports every shell; a server module that only needs to know
 * who is asking (the platform layout, a page) imports this one, so its route
 * does not carry the player's and the club's shells in its First Load JS.
 */

/**
 * Who is signed in, or `null`: the first of `playerChrome`'s reads, on its own
 * for a caller that needs nothing else (the home page's redirect). Guarded the
 * same way: an unreadable session is a signed-out visitor.
 */
export const chromeIdentity = cache(async () =>
  signedInIdentity().catch((err: unknown) => {
    unstable_rethrow(err);
    chromeReadFailed('identity', err);
    return null;
  }),
);

/**
 * Who the chrome is for, read once per request.
 *
 * The chrome, the 404 and the player pages all need it (T20, #362), and a
 * layout cannot pass props to a page, so it is `cache`d like
 * `signedInIdentity` beneath it: the session check, the landing read and the
 * grant read run once however many readers ask. `resolveLanding` is read from
 * the database, not the token: the token has neither club names nor club
 * status.
 *
 * `platform` is the live grant's capabilities (#345), from the same read the
 * platform layout makes, and `platformHref` its front door: empty and `null`
 * for everybody else.
 *
 * ═══ NO READ MAY BREAK THE PAGE (#319) ═══
 *
 * This runs in the layouts of /login, /invite/*, /venues and the 404, above
 * their `error.tsx`, so a throw here (the session store or the database
 * unreachable) took the whole page down, sign-in included, where nothing
 * could catch it. Each read falls back instead: no identity reads as signed
 * out, no landing as a player with no club, and the grant read already
 * degrades to "no grant" on its own. The page below still checks its own
 * session and answers for itself. Next's own control flow (a dynamic-usage
 * bail-out, a redirect) is rethrown, never swallowed.
 */
export const playerChrome = cache(async () => {
  const me = await chromeIdentity();
  const [landing, grant] = me
    ? await Promise.all([
        resolveLanding(me.userId).catch((err: unknown) => {
          unstable_rethrow(err);
          chromeReadFailed('landing', err);
          return null;
        }),
        resolvePlatformAuthority(me.userId),
      ])
    : [null, null];

  const platform = grant?.capabilities ?? [];
  return {
    me,
    landing,
    kind: playerChromeKind(me !== null, landing),
    modules: readModules(),
    platform,
    /** `/platform` for a holder of a live grant (#345), or nothing. */
    platformHref: platform.length > 0 ? PLATFORM_HREF : null,
  };
});

export function chromeReadFailed(
  read: 'identity' | 'landing' | 'membership' | 'resource-nouns',
  err: unknown,
) {
  logger.warn('player chrome read failed; rendering the fallback', {
    component: 'player-chrome',
    read,
    error: err instanceof Error ? err.message : String(err),
  });
}
