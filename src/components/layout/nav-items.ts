import type { LandingReason } from '@/lib/auth/landing';
import type { PlatformCapability } from '@/lib/platform/capabilities';
import type { Permission } from '@/lib/permissions';

/**
 * What the club-admin and platform shells link to — data, not a component.
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

/** The glyph a row shows. A key, because a component cannot cross to the client as a prop. */
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
  | 'security';

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

// ═══ THE PLAYER CHROME (T20, #362) ═════════════════════════════════════════

/**
 * Which player chrome a viewer gets: the site header's top links (from `md`)
 * and the bottom tab bar (below it). Three, not one per landing reason,
 * because the chrome only ever asks two questions: is anybody signed in, and
 * is this a CLUB account (#263)?
 *
 *   signed-out   Play · Sign in
 *   player       Play · (Games) · Bookings · Profile    (PLAYER, COACH, undecided)
 *   club         Play · Admin · Profile                 (CLUB, its club live or not)
 *
 * The owner's direction on #362. Games waits for the open-play module (#376)
 * behind `modules.openPlay`. A coach and an undecided account land on
 * /me/bookings today (`decideLanding`), so they get a player's tabs. A CLUB
 * account cannot book, so its middle tab is its way home: its club's admin.
 */
export type PlayerChromeKind = 'signed-out' | 'player' | 'club';

export function playerChromeKind(
  signedIn: boolean,
  reason: LandingReason | null | undefined,
): PlayerChromeKind {
  if (!signedIn) return 'signed-out';
  return reason === 'club' || reason === 'club-unavailable' ? 'club' : 'player';
}

/**
 * The modules a tab or a header icon waits for, read from the environment by
 * `src/lib/modules.ts`. Plain data: the server reads the flags once and the
 * client only draws what it is handed.
 */
export interface ChromeModules {
  /** Module 2, open play (#376): the Games tab and top link. */
  openPlay: boolean;
  /** Module 1, messaging (#375): the messages icon in the header. */
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

/** The glyph a tab shows, looked up on the client (`BottomTabBar`). */
export type PlayerTabIconKey = 'discover' | 'games' | 'bookings' | 'signIn' | 'profile' | 'admin';

/** A link in the player chrome. `labelKey` is under `common.nav`, as for the admin. */
export interface PlayerLink {
  href: string;
  labelKey: string;
  iconKey: PlayerTabIconKey;
}

/** The profile page: the Profile tab below `md`, the account menu's first row from it. */
export const PROFILE_HREF = '/me/profile';

/**
 * The platform's front door (#345): it redirects to the first platform page
 * the grant opens. The account menu and the profile link here, only for a
 * holder of a live grant.
 */
export const PLATFORM_HREF = '/platform';

const PLAY: PlayerLink = { href: '/venues', labelKey: 'play', iconKey: 'discover' };
const GAMES: PlayerLink = { href: MODULE_HREFS.openPlay, labelKey: 'games', iconKey: 'games' };
const BOOKINGS: PlayerLink = { href: '/me/bookings', labelKey: 'bookings', iconKey: 'bookings' };
const PROFILE: PlayerLink = { href: PROFILE_HREF, labelKey: 'profile', iconKey: 'profile' };
const SIGN_IN: PlayerLink = { href: '/login', labelKey: 'signIn', iconKey: 'signIn' };

/**
 * The header's top links, shown from `md` (the tab bar carries them below).
 *
 * Profile is not one: from `md` it is the account menu's first row, in the
 * menu that already holds the theme and sign-out, so neither lives in two
 * places on one screen. Sign-in is not one either: it is the header's
 * right-hand slot, where the account menu sits once somebody is signed in.
 */
export function playerTopLinks(
  kind: PlayerChromeKind,
  modules: ChromeModules = MODULES_OFF,
): PlayerLink[] {
  if (kind !== 'player') return [PLAY];
  return [PLAY, ...(modules.openPlay ? [GAMES] : []), BOOKINGS];
}

/**
 * The bottom tab bar's tabs, below `md`. Every tab is a page: Profile
 * replaced the Account tab, which opened the account menu as a sheet.
 *
 * `adminHref` is where a CLUB account's admin starts (`landing.href`). A CLUB
 * account whose club is not live has none, and so no Admin tab: a link to an
 * admin that would refuse it is no way home.
 */
export function playerTabs(
  kind: PlayerChromeKind,
  opts: { modules?: ChromeModules; adminHref?: string | null } = {},
): PlayerLink[] {
  const modules = opts.modules ?? MODULES_OFF;
  switch (kind) {
    case 'signed-out':
      return [PLAY, SIGN_IN];
    case 'player':
      return [PLAY, ...(modules.openPlay ? [GAMES] : []), BOOKINGS, PROFILE];
    case 'club': {
      const admin: PlayerLink[] = opts.adminHref
        ? [{ href: opts.adminHref, labelKey: 'admin', iconKey: 'admin' }]
        : [];
      return [PLAY, ...admin, PROFILE];
    }
  }
}

/**
 * Every href the player chrome and the account rows link with the modules off,
 * for `nav-hrefs-resolve`. The Admin tab's href is the club's (`clubHome`),
 * which that guard already follows through `clubAdminNav`.
 */
export function playerChromeHrefs(): string[] {
  const kinds: PlayerChromeKind[] = ['signed-out', 'player', 'club'];
  return [
    ...new Set([
      ...kinds.flatMap((k) => [
        ...playerTopLinks(k).map((l) => l.href),
        ...playerTabs(k).map((t) => t.href),
      ]),
      PROFILE_HREF,
      PLATFORM_HREF,
      clubPublicHref('sample-club'),
    ]),
  ];
}
