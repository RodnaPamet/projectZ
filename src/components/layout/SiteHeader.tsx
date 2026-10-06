import { cache } from 'react';

import { unstable_rethrow } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import type { AccountLinks } from '@/components/layout/account-links';
import {
  PLATFORM_HREF,
  playerChromeKind,
  playerTopLinks,
  PROFILE_HREF,
} from '@/components/layout/nav-items';
import { SiteHeaderView } from '@/components/layout/site-header-view';
import { signedInIdentity } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';
import { readModules } from '@/lib/modules';
import { logger } from '@/lib/observability/logger';

/**
 * Who the player chrome is for, read once per request.
 *
 * The header, the bottom tab bar and the profile page all need it (T20, #362),
 * and a layout cannot pass props to a page, so it is `cache`d like
 * `signedInIdentity` beneath it: the session check, the landing read and the
 * grant read run once however many pieces of chrome ask. `resolveLanding` is
 * read from the database, not the token: the token has neither club names nor
 * club status.
 *
 * ═══ WHAT EACH ACCOUNT CAN REACH (#362) ═══
 *
 * `account` is the account rows the menu and the profile page draw: the
 * profile for everyone signed in, the club's admin for a CLUB account with a
 * live club (#346), and `/platform` for a holder of a live platform grant
 * (#345), from the same grant read the platform layout makes. Hiding only:
 * the admin and the platform authorise every request themselves.
 *
 * ═══ NO READ MAY BREAK THE PAGE (#319) ═══
 *
 * This runs in the layouts of /login, /invite/*, /venues and the 404, above
 * their `error.tsx`, so a throw here (the session store or the database
 * unreachable) took the whole page down, sign-in included, where nothing
 * could catch it. Each read now falls back instead: no identity reads as
 * signed out, no landing as a player with no club link, and the grant read
 * already degrades to "no grant" on its own. The page below still checks its
 * own session and answers for itself. Next's own control flow (a
 * dynamic-usage bail-out, a redirect) is rethrown, never swallowed.
 */
export const playerChrome = cache(async () => {
  const me = await signedInIdentity().catch((err: unknown) => {
    unstable_rethrow(err);
    chromeReadFailed('identity', err);
    return null;
  });
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

  const account: AccountLinks | null = me
    ? {
        profileHref: PROFILE_HREF,
        clubAdmin: landing?.club ? { href: landing.href } : null,
        platformHref: grant && grant.capabilities.length > 0 ? PLATFORM_HREF : null,
        publicSite: null,
      }
    : null;

  return {
    me,
    landing,
    account,
    kind: playerChromeKind(me !== null, landing?.reason),
    modules: readModules(),
  };
});

function chromeReadFailed(read: 'identity' | 'landing', err: unknown) {
  logger.warn('player chrome read failed; rendering the fallback', {
    component: 'player-chrome',
    read,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The public site header, on upstream's vendored `NavBar` slots (T20, #362).
 *
 *   left   the charcoal wordmark · from md, Играй, (Игри) and Резервации
 *   right  a club account's "← Към админ" · (messages) · the bell ·
 *          from md, the account menu or Вход
 *
 * Below `md` the bottom tab bar carries the links and the profile, so the
 * header there is the wordmark, the club's way back to its admin, and the
 * icons. The markup is `SiteHeaderView`, from plain data.
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
 * ═══ AND THE WAY BACK TO THE CLUB'S ADMIN (#263, #346) ═══
 *
 * One account is one kind, so there is no switcher. A club account browsing
 * the venues needs a way back to its admin without signing in again. It was
 * the club's name as plain header text, easy to miss on a phone (#346). It is
 * now a primary button, "← Към админ", at every width, and "Админ на клуба" in
 * the account menu. A PLAYER account sees neither.
 */
export async function SiteHeader() {
  const [tNav, { me, account, kind, modules }] = await Promise.all([
    getTranslations('common.nav'),
    playerChrome(),
  ]);

  return (
    <SiteHeaderView
      links={playerTopLinks(kind, modules).map((l) => ({ href: l.href, label: tNav(l.labelKey) }))}
      identity={me ? { name: me.name, email: me.email } : null}
      account={account}
      messaging={modules.messaging}
    />
  );
}
