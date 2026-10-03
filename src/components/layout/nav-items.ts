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
export type NavIconKey = 'calendar' | 'courts' | 'pricing' | 'players' | 'staff' | 'moderation';

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

/** A platform item, shown only to a holder of a live grant carrying `requires`. */
export interface PlatformNavItem extends NavItem {
  requires: PlatformCapability;
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
 *   Venue       Courts, Pricing
 *   People      Players, Staff
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
  ];
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

// ═══ THE PLAYER CHROME (T20) ═══════════════════════════════════════════════

/**
 * Which player chrome a viewer gets: the site header's top links (from `md`)
 * and the bottom tab bar (below it). Three, not one per landing reason,
 * because the chrome only ever asks two questions: is anybody signed in, and
 * is this a CLUB account (#263)?
 *
 *   signed-out   Discover · Sign in
 *   player       Discover · My bookings · Account   (PLAYER, COACH, undecided)
 *   club         Discover · Account                 (CLUB, its club live or not)
 *
 * A coach and an undecided account land on /me/bookings today
 * (`decideLanding`), so they get a player's tabs. A CLUB account has no
 * bookings of its own to show; its way home is the header's link to its one
 * club, which is the ONLY club reference in this chrome. There is no club tab,
 * and a PLAYER account sees no club anywhere here.
 */
export type PlayerChromeKind = 'signed-out' | 'player' | 'club';

export function playerChromeKind(
  signedIn: boolean,
  reason: LandingReason | null | undefined,
): PlayerChromeKind {
  if (!signedIn) return 'signed-out';
  return reason === 'club' || reason === 'club-unavailable' ? 'club' : 'player';
}

/** The glyph a tab shows, looked up on the client (`BottomTabBar`). */
export type PlayerTabIconKey = 'discover' | 'bookings' | 'signIn' | 'account';

/** A link in the player chrome. `labelKey` is under `common.nav`, as for the admin. */
export interface PlayerLink {
  href: string;
  labelKey: string;
  iconKey: PlayerTabIconKey;
}

/**
 * A tab: a link, or the Account tab, which is not a page but the account menu
 * (the vendored `UserMenu`, a bottom sheet on a phone). There is no `/account`
 * route to link to, and the menu is where the theme and sign-out live.
 */
export type PlayerTab =
  ({ type: 'link' } & PlayerLink) | { type: 'account'; labelKey: 'account'; iconKey: 'account' };

const DISCOVER: PlayerLink = { href: '/venues', labelKey: 'play', iconKey: 'discover' };
const MY_BOOKINGS: PlayerLink = {
  href: '/me/bookings',
  labelKey: 'myBookings',
  iconKey: 'bookings',
};
const SIGN_IN: PlayerLink = { href: '/login', labelKey: 'signIn', iconKey: 'signIn' };

/**
 * The header's top links, shown from `md` (the tab bar carries them below).
 * Sign-in is not one: it is the header's right-hand slot, where the account
 * menu sits once somebody is signed in.
 */
export function playerTopLinks(kind: PlayerChromeKind): PlayerLink[] {
  return kind === 'player' ? [DISCOVER, MY_BOOKINGS] : [DISCOVER];
}

/** The bottom tab bar's tabs, below `md`. */
export function playerTabs(kind: PlayerChromeKind): PlayerTab[] {
  const account = { type: 'account', labelKey: 'account', iconKey: 'account' } as const;
  switch (kind) {
    case 'signed-out':
      return [
        { type: 'link', ...DISCOVER },
        { type: 'link', ...SIGN_IN },
      ];
    case 'player':
      return [{ type: 'link', ...DISCOVER }, { type: 'link', ...MY_BOOKINGS }, account];
    case 'club':
      return [{ type: 'link', ...DISCOVER }, account];
  }
}

/** Every href the player chrome can link, for `nav-hrefs-resolve`. */
export function playerChromeHrefs(): string[] {
  const kinds: PlayerChromeKind[] = ['signed-out', 'player', 'club'];
  return [
    ...new Set(
      kinds.flatMap((k) => [
        ...playerTopLinks(k).map((l) => l.href),
        ...playerTabs(k).flatMap((t) => (t.type === 'link' ? [t.href] : [])),
      ]),
    ),
  ];
}
