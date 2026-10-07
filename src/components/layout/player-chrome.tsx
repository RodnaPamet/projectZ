import { cache, type ReactNode } from 'react';

import { unstable_rethrow } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { resolveTenantPageContext, signedInIdentity } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';
import { readModules } from '@/lib/modules';
import { logger } from '@/lib/observability/logger';

import { BottomTabBar } from './BottomTabBar';
import { ClubAdminShell } from './club-admin-shell';
import {
  clubShell,
  playerChromeKind,
  playerShellNav,
  PROFILE_HREF,
  PLATFORM_HREF,
  toShellSections,
  type ClubShellData,
} from './nav-items';
import { PlayerShell } from './player-shell';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './site-footer';

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

function chromeReadFailed(read: 'identity' | 'landing' | 'membership', err: unknown) {
  logger.warn('player chrome read failed; rendering the fallback', {
    component: 'player-chrome',
    read,
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The frame around every page of the site (T20, #362), decided ON THE SERVER
 * from `playerChrome`, so the first byte is already the right chrome: no
 * flash of the public header before the shell, and nothing for the client to
 * guess.
 *
 *   signed out   the public header, the page in `<main>`, the footer (`footer`),
 *                and below `md` the bottom tab bar (Играй · Вход)
 *   player,      `PlayerShell`: upstream's AppShell frame with the player's
 *   coach        sidebar (Играй · Резервации · Профил, the modules' items,
 *                and Платформа for a grant holder), the bell, the account
 *                menu, and below `md` the drawer and the tab bar
 *   club         `ClubAdminShell` with its club's admin sidebar, exactly as on
 *                its admin pages (owner, 2026-10-07): one account, one kind,
 *                one sidebar
 *
 * Rendered by `src/app/(public)/layout.tsx` (every public page, and /me, so a
 * tap between Играй and Резервации keeps the shell mounted), by the home
 * page's layout for a signed-out visitor, and by the 404.
 *
 * The public chrome is a column at least one screen tall, so a page's root can
 * take `flex-1` and centre itself in what the header and the tab bar leave. It
 * owns the `<main>` landmark in both frames (the shell's `<main>` is the
 * vendored frame's), so a page renders none of its own.
 *
 * `footer` adds the public footer (#368, #369), whose language switch is the
 * one a signed-out visitor can reach. A signed-in account's language lives on
 * /me/profile, so no frame of theirs has a footer.
 */
export async function PlayerChrome({
  children,
  footer = false,
}: {
  children: ReactNode;
  footer?: boolean;
}) {
  const { me, landing, kind, modules, platform, platformHref } = await playerChrome();

  if (!me || kind === 'signed-out') {
    return (
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main className="flex flex-1 flex-col">{children}</main>
        {footer ? <SiteFooter /> : null}
        <BottomTabBar kind="signed-out" modules={modules} />
      </div>
    );
  }

  const [tNav, tCommon] = await Promise.all([
    getTranslations('common.nav'),
    getTranslations('common'),
  ]);
  const user = { name: me.name, email: me.email };

  if (kind === 'club') {
    const club = await clubFrame(landing?.club?.tenantSlug ?? null, platform, tNav);
    return (
      <ClubAdminShell
        sections={club?.sections ?? []}
        homeHref={club?.homeHref}
        contextName={club?.contextName ?? tCommon('appName')}
        user={user}
        account={club?.account ?? { profileHref: PROFILE_HREF, platformHref, publicSite: null }}
        bottomTabs
      >
        {children}
      </ClubAdminShell>
    );
  }

  return (
    <PlayerShell
      sections={toShellSections(playerShellNav(kind, { modules, platform }), tNav)}
      contextName={tCommon('appName')}
      user={{ userId: me.userId, ...user }}
      kind={kind}
      modules={modules}
    >
      {children}
    </PlayerShell>
  );
}

/**
 * A CLUB account's frame, off its admin: the same `clubShell` its admin layout
 * draws, from the membership `resolveTenantPageContext` reads for that club
 * (request-cached, so the admin layout asking too is one query). `null` when
 * there is no live club to draw: its club suspended or closed, or the
 * membership gone. The account still wears the club frame, with no admin
 * pages in it, never a player's.
 */
async function clubFrame(
  slug: string | null,
  platform: Parameters<typeof clubShell>[1]['platform'],
  t: (key: string) => string,
): Promise<ClubShellData | null> {
  if (!slug) return null;
  const result = await resolveTenantPageContext(slug).catch((err: unknown) => {
    unstable_rethrow(err);
    chromeReadFailed('membership', err);
    return null;
  });
  return result?.kind === 'ok' ? clubShell(result.ctx, { platform, t }) : null;
}
