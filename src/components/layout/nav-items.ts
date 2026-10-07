import { PLAY_PATH, type LandingDecision } from '@/lib/auth/landing';
import type { PlatformCapability } from '@/lib/platform/capabilities';
import type { Permission } from '@/lib/permissions';

/**
 * What the signed-in shells and the public chrome link to — data, not a component.
 *
 * ═══ WHY THIS MODULE HAS NO DIRECTIVE ═══
 *
 * The builders lived in the old `AppNav.tsx`, which is `'use client'`, and the
 * club layout — a Server Component — CALLED them. React Server Components
 * forbid that: every export of a client module is a client reference on the
 * server, and calling one throws
 *
 *   Attempted to call playerNav() from the server but playerNav is on the
 *   client. It's not possible to invoke a client function from the server.
 *
 * So every page under `/t/[slug]` answered 500 from #195 until #227 moved them
 * here. The admin layouts call these on the server, filter them by the
 * database-resolved permissions, translate the labels, and hand the shell
 * plain data. `client-boundary` holds that line.
 *
 * ═══ WHAT IS NOT HERE ANY MORE (#260) ═══
 *
 * `playerNav` linked `/t/{slug}/open-play`, `/coaches` and `/my-bookings`,
 * none of which has ever existed: three links to a 404, each prefetching that
 * 404 as it scrolled into view (#267). A CLUB account (#263) never sees player
 * links anyway, and players get their own bottom tab bar (T20), so the builder
 * went with them. `tests/guardrails/nav-hrefs-resolve.test.ts` now fails any
 * href here that has no `page.tsx` behind it.
 */

/**
 * The glyph a row or a tab shows. A key, because a component cannot cross to
 * the client as a prop; `nav-icons.tsx` maps each to its Nucleo glyph.
 */
export type NavIconKey =
  | 'calendar'
  | 'courts'
  | 'pricing'
  | 'photos'
  | 'players'
  | 'staff'
  | 'reports'
  | 'moderation'
  | 'fees'
  | 'usage'
  | 'security'
  | 'contactRequests'
  // The player shell and the bottom tab bar (#362).
  | 'discover'
  | 'games'
  | 'bookings'
  | 'messages'
  | 'profile'
  | 'signIn';

export interface NavItem {
  href: string;
  /**
   * A key under `common.nav`, NOT display text.
   *
   * These were literal English once — 'Play', 'Calendar', 'Courts' — in the
   * nav of an app whose default locale is Bulgarian. `i18n-no-hardcoded-copy`
   * reads JSX text and copy-carrying attributes, and copy declared in a data
   * structure and rendered through a variable was invisible to it. Naming the
   * field `labelKey`, not `label`, keeps a key from inviting text back in.
   */
  labelKey: string;
  iconKey: NavIconKey;
  /**
   * The router's prefetch for this link. Always `'auto'`, by type.
   *
   * docs/perf/navigation-policy.md: admin links fetch each dynamic route down
   * to its `loading.tsx`, never in full. A fully prefetched diary would live
   * under `staleTimes.static` and could be 180 s old on the tap, and every
   * revalidating admin write would re-prefetch each such link in full. The
   * vendored NavItem defaults to a full prefetch (upstream's choice), so the
   * value is carried on every item rather than left to that default.
   */
  prefetch: 'auto';
}

/** A club item, shown only to a member whose role holds `requires`. */
export interface ClubNavItem extends NavItem {
  requires: Permission;
}

/**
 * A platform item, shown only to a holder of a live grant carrying `requires` —
 * or, for `'ANY_GRANT'`, to the holder of any live grant at all. That is the
 * security page (#262): enrolling a second factor is open to every grant
 * holder, whatever their grant carries.
 */
export interface PlatformNavItem extends NavItem {
  requires: PlatformCapability | 'ANY_GRANT';
}

/** Whether a holder of `capabilities` is shown `item`. Hiding only; the API authorises. */
export function platformItemAllowed(
  item: PlatformNavItem,
  capabilities: readonly PlatformCapability[],
): boolean {
  return item.requires === 'ANY_GRANT'
    ? capabilities.length > 0
    : capabilities.includes(item.requires);
}

export interface NavSection<T extends NavItem = NavItem> {
  /** A key under `common.nav`. The first section has none: it is the home row. */
  titleKey?: string;
  items: T[];
}

/**
 * The club-admin surface. Every item is permission-gated, and the gate is the
 * same permission the page itself demands, so a link is never shown to
 * somebody the page would refuse (`route-permission-coverage`).
 *
 *   (no title)  Calendar — the diary, where staff spend the day
 *   Venue       Courts, Pricing, Photos and info (#366)
 *   People      Players, Staff
 *   Finance     Reports and fee (#372): OWNER and MANAGER only
 *
 * A COACH holds `players.view` and nothing else here, so a coach sees only
 * Players: today's permission-based view, kept until the coach UI decides.
 */
export function clubAdminNav(slug: string): NavSection<ClubNavItem>[] {
  const href = (page: string) => `/t/${slug}/admin/${page}`;
  return [
    {
      items: [
        {
          href: href('calendar'),
          labelKey: 'calendar',
          iconKey: 'calendar',
          requires: 'bookings.view_all',
          prefetch: 'auto',
        },
      ],
    },
    {
      titleKey: 'sectionVenue',
      items: [
        {
          href: href('courts'),
          labelKey: 'courts',
          iconKey: 'courts',
          requires: 'courts.manage',
          prefetch: 'auto',
        },
        {
          href: href('pricing'),
          labelKey: 'pricing',
          iconKey: 'pricing',
          requires: 'admin.pricing_manage',
          prefetch: 'auto',
        },
        {
          // "Снимки" (#366), the page "Снимки и информация": the drawer's long
          // tail on a phone, never a tab. The full name was clipped by the
          // vendored rail at 1280 px (audit C09's check), so the link is short
          // and the page heading says it all. The page asks the same permission.
          href: href('photos'),
          labelKey: 'photos',
          iconKey: 'photos',
          requires: 'admin.venue_manage',
          prefetch: 'auto',
        },
      ],
    },
    {
      titleKey: 'sectionPeople',
      items: [
        {
          href: href('players'),
          labelKey: 'players',
          iconKey: 'players',
          requires: 'players.view',
          prefetch: 'auto',
        },
        {
          href: href('staff'),
          labelKey: 'staff',
          iconKey: 'staff',
          requires: 'admin.staff_manage',
          prefetch: 'auto',
        },
      ],
    },
    {
      titleKey: 'sectionFinance',
      items: [
        {
          // "Отчети и такса" (#372): the monthly fee statement and its CSV.
          // `admin.billing_manage` is OWNER and MANAGER; the page and the
          // statement API ask the same, so STAFF never see the link.
          href: href('reports'),
          labelKey: 'reports',
          iconKey: 'reports',
          requires: 'admin.billing_manage',
          prefetch: 'auto',
        },
      ],
    },
  ];
}

/**
 * Where "Публична страница ↗" leads from a club's admin (#347, #362): the
 * club's own public page, `/clubs/{slug}` (#356), which lists every venue it
 * runs — or says it has none yet. It replaced the club's first live venue
 * page, which needed a database read on every admin render to find.
 */
export function clubPublicHref(clubSlug: string): string {
  return `/clubs/${encodeURIComponent(clubSlug)}`;
}

/** The platform surface: what a holder of a platform grant can open. */
export function platformNav(): NavSection<PlatformNavItem>[] {
  return [
    {
      items: [
        {
          href: '/platform/moderation',
          labelKey: 'moderation',
          iconKey: 'moderation',
          requires: 'REVIEW_MODERATE',
          prefetch: 'auto',
        },
        {
          // Every club's fee for a month, to invoice from (#372). Reading is
          // TENANT_READ; changing a club's terms on the page needs
          // CLUB_FEE_MANAGE as well, and the page only shows that control to
          // a grant that carries it.
          href: '/platform/fees',
          labelKey: 'fees',
          iconKey: 'fees',
          requires: 'TENANT_READ',
          prefetch: 'auto',
        },
        {
          // The pilot's numbers (#371): a read, so TENANT_READ and no step-up.
          href: '/platform/usage',
          labelKey: 'usage',
          iconKey: 'usage',
          requires: 'TENANT_READ',
          prefetch: 'auto',
        },
        {
          // The landing page's club enquiries (#369).
          href: '/platform/contact-requests',
          labelKey: 'contactRequests',
          iconKey: 'contactRequests',
          requires: 'CONTACT_READ',
          prefetch: 'auto',
        },
        {
          href: '/platform/security',
          labelKey: 'security',
          iconKey: 'security',
          requires: 'ANY_GRANT',
          prefetch: 'auto',
        },
      ],
    },
  ];
}

/**
 * What the shell receives: the visible sections, labels already translated on
 * the server. Plain data, so it crosses into the client shell as props.
 */
export interface ShellNavItem {
  href: string;
  label: string;
  iconKey: NavIconKey;
  prefetch: 'auto';
}

export interface ShellNavSection {
  title?: string;
  items: ShellNavItem[];
}

/**
 * Keep the items `allows` admits, and drop any section left empty.
 *
 * Hiding a link is a courtesy, NOT a security control: every page and every
 * Server Action authorises itself. This only keeps the nav from offering a
 * page that would refuse the viewer.
 */
export function visibleSections<T extends NavItem>(
  sections: NavSection<T>[],
  allows: (item: T) => boolean,
): NavSection<T>[] {
  return sections
    .map((s) => ({ ...s, items: s.items.filter(allows) }))
    .filter((s) => s.items.length > 0);
}

/**
 * Translate the visible sections into what the shell renders.
 *
 * `t` is `getTranslations('common.nav')` on the server. `requires` is dropped
 * on the way: the client has no use for it, and a permission name in the
 * payload is a list of what the role can do.
 */
export function toShellSections(
  sections: NavSection[],
  t: (key: string) => string,
): ShellNavSection[] {
  return sections.map((s) => ({
    ...(s.titleKey ? { title: t(s.titleKey) } : {}),
    items: s.items.map((i) => ({
      href: i.href,
      label: t(i.labelKey),
      iconKey: i.iconKey,
      prefetch: i.prefetch,
    })),
  }));
}

// ═══ WHICH FRAME AN ACCOUNT WEARS (#362) ═══════════════════════════════════

/**
 * The chrome a viewer gets around every page they open, decided on the server
 * from the session and the account's landing (`playerChrome`):
 *
 *   signed-out   the public site's header and footer, and below `md` the
 *                bottom tab bar (Играй · Вход)
 *   player       the AppShell frame with the player's sidebar
 *   coach        the same frame with a coach's sidebar: a player's items until
 *                the coach module (#377) ships its own (`SIGNED_IN_NAV`)
 *   club         the AppShell frame with its CLUB's admin sidebar, on admin and
 *                public pages alike (owner, 2026-10-07): one account, one kind
 *                (#263), so a club account never sees the player sidebar
 *
 * An account that has not chosen its kind lands where #227 landed it
 * (`decideLanding`): one that lands on a club's admin wears that club's frame,
 * any other one a player's.
 */
export type PlayerChromeKind = 'signed-out' | 'player' | 'coach' | 'club';

export function playerChromeKind(
  signedIn: boolean,
  landing: Pick<LandingDecision, 'reason' | 'club'> | null | undefined,
): PlayerChromeKind {
  if (!signedIn) return 'signed-out';
  switch (landing?.reason) {
    case 'club':
    case 'club-unavailable':
      return 'club';
    case 'coach':
      return 'coach';
    case 'undecided':
      return landing.club ? 'club' : 'player';
    default:
      return 'player';
  }
}

/**
 * The modules an item waits for, read from the environment by
 * `src/lib/modules.ts`. Plain data: the server reads the flags once and the
 * client only draws what it is handed.
 */
export interface ChromeModules {
  /** Module 2, open play (#376): Игри, in the sidebar and as a tab. */
  openPlay: boolean;
  /** Module 1, messaging (#375): Съобщения, in the sidebar. */
  messaging: boolean;
}

/** Every module off: what ships until a flag is switched on. */
export const MODULES_OFF: ChromeModules = { openPlay: false, messaging: false };

/**
 * Where each module's entry points once the module ships. Nothing is behind
 * them yet, which is why both flags default off; `nav-hrefs-resolve` fails if
 * a flag defaults on while its href has no page.
 */
export const MODULE_HREFS = {
  openPlay: '/games',
  messaging: '/messages',
} as const satisfies Record<keyof ChromeModules, string>;

/** A link in the player chrome. `labelKey` is under `common.nav`, as for the admin. */
export interface PlayerLink {
  href: string;
  labelKey: string;
  iconKey: NavIconKey;
}

/** The profile page: Профил in the sidebar and the tab bar, and the account menu's first row. */
export const PROFILE_HREF = '/me/profile';

/**
 * The platform's front door (#345): it redirects to the first platform page
 * the grant opens. A club account's account rows link here, for a holder of a
 * live grant; a player's sidebar lists the pages themselves.
 */
export const PLATFORM_HREF = '/platform';

/**
 * Where "home" is for a signed-in account: Играй, the venue index. `/`
 * redirects a signed-in visitor here (`src/app/(home)/layout.tsx`), so the
 * shells' wordmark and the platform's "Към сайта" link here directly rather
 * than through that hop.
 */
export const SIGNED_IN_HOME = PLAY_PATH;

const PLAY: PlayerLink = { href: PLAY_PATH, labelKey: 'play', iconKey: 'discover' };
const GAMES: PlayerLink = { href: MODULE_HREFS.openPlay, labelKey: 'games', iconKey: 'games' };
const BOOKINGS: PlayerLink = { href: '/me/bookings', labelKey: 'bookings', iconKey: 'bookings' };
const MESSAGES: PlayerLink = {
  href: MODULE_HREFS.messaging,
  labelKey: 'messages',
  iconKey: 'messages',
};
const PROFILE: PlayerLink = { href: PROFILE_HREF, labelKey: 'profile', iconKey: 'profile' };
const SIGN_IN: PlayerLink = { href: '/login', labelKey: 'signIn', iconKey: 'signIn' };

/**
 * The public header's links, from `md` (signed out only; the tab bar carries
 * them below it). Sign-in is not one: it is the header's right-hand slot.
 */
export const PUBLIC_HEADER_LINKS: readonly PlayerLink[] = [PLAY];

/**
 * THE ITEMS EACH SIGNED-IN KIND'S SIDEBAR STARTS WITH, one list per kind.
 *
 * Игри and Съобщения wait for their modules (#376, #375). A coach has a
 * player's items until the coach module (#377) ships coach pages: that is the
 * line to change then, and nothing else has to. A CLUB account is not here:
 * its sidebar is its club's admin (`clubAdminNav`), built by `clubShell`.
 */
export const SIGNED_IN_NAV: Record<'player' | 'coach', (modules: ChromeModules) => PlayerLink[]> = {
  player: (m) => [
    PLAY,
    ...(m.openPlay ? [GAMES] : []),
    BOOKINGS,
    ...(m.messaging ? [MESSAGES] : []),
    PROFILE,
  ],
  coach: (m) => SIGNED_IN_NAV.player(m),
};

/**
 * The sidebar of the player shell (the player's and the coach's frame): the
 * kind's items, then, for a holder of a live platform grant, a "Платформа"
 * section listing the platform pages that grant opens. That section is the
 * same filter the platform layout draws its own sidebar with
 * (`platformItemAllowed` over `platformNav`), so the two cannot disagree about
 * which pages a grant reaches. Hiding only: `/platform` authorises itself.
 */
export function playerShellNav(
  kind: 'player' | 'coach',
  opts: { modules?: ChromeModules; platform?: readonly PlatformCapability[] } = {},
): NavSection[] {
  const items: NavItem[] = SIGNED_IN_NAV[kind](opts.modules ?? MODULES_OFF).map((l) => ({
    ...l,
    prefetch: 'auto' as const,
  }));
  const platform = visibleSections(platformNav(), (item) =>
    platformItemAllowed(item, opts.platform ?? []),
  ).map((s) => ({ ...s, titleKey: 'platform' }));
  return [{ items }, ...platform];
}

/**
 * The bottom tab bar's tabs, below `md`. Every tab is a page.
 *
 * Signed in, the tabs are RESOLVED from the sidebar's own items, agrent's
 * pattern (#362): Играй · (Игри) · Резервации · Профил, so the bar can never
 * offer a page the sidebar does not. Съобщения and the platform stay in the
 * drawer. A CLUB account wears its admin's bar (`ClubAdminTabBar`).
 */
const TAB_HREFS: readonly string[] = [PLAY.href, GAMES.href, BOOKINGS.href, PROFILE.href];

export function playerTabs(
  kind: Exclude<PlayerChromeKind, 'club'>,
  modules: ChromeModules = MODULES_OFF,
): PlayerLink[] {
  if (kind === 'signed-out') return [PLAY, SIGN_IN];
  return SIGNED_IN_NAV[kind](modules).filter((l) => TAB_HREFS.includes(l.href));
}

/**
 * Every href the player chrome links with the modules off, for
 * `nav-hrefs-resolve`. The club's admin hrefs are `clubAdminNav`'s, which that
 * guard follows itself.
 */
export function playerChromeHrefs(): string[] {
  return [
    ...new Set([
      ...PUBLIC_HEADER_LINKS.map((l) => l.href),
      ...(['signed-out', 'player', 'coach'] as const).flatMap((k) =>
        playerTabs(k).map((t) => t.href),
      ),
      ...(['player', 'coach'] as const).flatMap((k) =>
        playerShellNav(k).flatMap((s) => s.items.map((i) => i.href)),
      ),
      PROFILE_HREF,
      PLATFORM_HREF,
      SIGNED_IN_HOME,
      clubPublicHref('sample-club'),
    ]),
  ];
}

// ═══ THE ACCOUNT ROWS, AND THE CLUB'S FRAME (#362) ══════════════════════════

/**
 * What an account can reach beyond the page it is on (#362, #345, #347), in
 * the account menu and at the foot of the drawer. Plain data, decided on the
 * server, so each kind's rows are a fact the server already checked, never a
 * guess the client makes:
 *
 *   profile       `/me/profile`, for every signed-in account; `null` where the
 *                 sidebar already lists Профил (the player shell's drawer)
 *   platform      a holder of a live platform grant: `/platform` (#345)
 *   publicSite    inside a club's or the platform's shell: the way out (#347)
 *
 * Hiding a row is a courtesy, not a control: `/platform` and the club admin
 * authorise every request themselves.
 */
export interface AccountLinks {
  profileHref: string | null;
  platformHref: string | null;
  publicSite: { href: string; label: string } | null;
}

/** What `ClubAdminShell` draws for one club, decided on the server. */
export interface ClubShellData {
  sections: ShellNavSection[];
  /** The shell's own start, which the club's name in the top bar links to. */
  homeHref: string;
  contextName: string;
  account: AccountLinks;
}

/**
 * THE CLUB'S FRAME, for its admin layout and for a CLUB account on any other
 * page (#362, owner 2026-10-07): one builder, so the account sees one sidebar
 * wherever it is.
 *
 * The sections are `clubAdminNav` kept to what the membership's role opens,
 * from the permissions `resolveTenantPageContext` read from the database for
 * THIS club (never the token's), translated, with no permission names left
 * in them. The account rows are the club's public page (#356), the profile,
 * and the platform for a holder of a live grant.
 */
export function clubShell(
  ctx: { tenantSlug: string; tenantName: string; permissions: readonly Permission[] },
  opts: { platform: readonly PlatformCapability[]; t: (key: string) => string },
): ClubShellData {
  const sections = visibleSections(clubAdminNav(ctx.tenantSlug), (item) =>
    ctx.permissions.includes(item.requires),
  );
  return {
    sections: toShellSections(sections, opts.t),
    homeHref: `/t/${ctx.tenantSlug}/admin`,
    contextName: ctx.tenantName,
    account: {
      profileHref: PROFILE_HREF,
      platformHref: opts.platform.length > 0 ? PLATFORM_HREF : null,
      publicSite: { href: clubPublicHref(ctx.tenantSlug), label: opts.t('publicPage') },
    },
  };
}
