import type { AccountKind, MembershipStatus, Role, TenantStatus } from '@prisma/client';

/**
 * Where a person lands after signing in (#227, by account kind since #263).
 *
 * ═══ ONE ACCOUNT, ONE KIND ═══
 *
 * #227 started from "one identity, several contexts": an owner who also plays,
 * a coach at one club who plays at another. It landed people by the MIX of
 * roles they held and gave the header a switcher between them. The owner has
 * since decided the opposite (#263): an account is a PLAYER, a CLUB account
 * (one club) or a COACH, and doing two of those takes two accounts. So there
 * is nothing to switch between and nothing to remember — the kind decides:
 *
 *   kind        lands on
 *   ─────────   ─────────────────────────────────────────────────────────
 *   PLAYER      the player UI
 *   CLUB        its one club's diary; the home page if that club is gone
 *   COACH       the coach UI — the player UI until one exists (COACH_HOME)
 *   undecided   #227's old default, for the accounts #263 would not decide
 *
 * A deep link still wins over all of this: `/login` honours `?next=` first,
 * and only a sign-in with no destination of its own comes to `/start`. See
 * `postSignInPath` at the end of this file, which is unchanged.
 *
 * ═══ PURE, AND DELIBERATELY SO ═══
 *
 * No database, no request, no Node-only import — the only import is a TYPE,
 * which compiles away. `/start` asks it after a sign-in, the site header asks
 * it for the link back to your club, and `GET /api/v1/me` gives the iOS client
 * its reason, without the href (#252, `@/app-layer/usecases/me`). The reads
 * that feed it live in `@/app-layer/usecases/landing`.
 */

/**
 * The player UI.
 *
 * `/me/bookings` is the only player page there is; #224 builds the rest. When
 * it lands, this is the line to change.
 */
export const PLAYER_HOME = '/me/bookings';

/** Where next-auth sends someone with no destination of their own. */
export const START_PATH = '/start';

/**
 * "Играч или треньор?" (#360, Q13): where an account that has not chosen its
 * kind, and holds no club role to land on, is sent before anything else.
 */
export const KIND_CHOOSER_PATH = '/start/kind';

/**
 * Where a person lands right after choosing PLAYER: Играй, the venue index,
 * because a new player has nothing in Резервации yet.
 */
export const PLAY_PATH = '/venues';

/**
 * Where a CLUB account lands when its club is not there to land on — suspended,
 * closed, or its own membership ended. Not the player UI: a club account is
 * not a player, and landing it on "your bookings" would be a page about
 * somebody it is not.
 */
export const HOME = '/';

/**
 * ═══ THE ONE LINE TO CHANGE WHEN THE COACH UI EXISTS ═══
 *
 * There is no coach UI: `usecases/coach.ts` has no route and `Coach.bio` says
 * so. Until there is, a coach lands on the player UI.
 *
 * When the coach UI ships, set this to its per-club home, e.g.
 *
 *   export const COACH_HOME: CoachHome = (slug) => `/t/${slug}/coach`;
 *
 * and coach landing and the `/t/[slug]` index both follow.
 *
 * Asserted through `as` rather than annotated: with a plain annotation,
 * TypeScript narrows a `const … = null` to `null` at every use and the code
 * paths for a real coach home stop type-checking at all.
 */
export type CoachHome = ((slug: string) => string) | null;
export const COACH_HOME = null as CoachHome;

/** The roles that run a club, and so land on its admin UI. */
export type ClubRole = Extract<Role, 'OWNER' | 'MANAGER' | 'STAFF'>;

/**
 * Highest authority first. Used only to choose among clubs for an account the
 * migration left undecided; it decides nothing about what anyone may do.
 */
const CLUB_ROLE_RANK: Readonly<Record<ClubRole, number>> = { OWNER: 0, MANAGER: 1, STAFF: 2 };

export function isClubRole(role: string): role is ClubRole {
  return Object.hasOwn(CLUB_ROLE_RANK, role);
}

/**
 * A club's landing page: the diary.
 *
 * Named directly rather than via the `/t/[slug]/admin` index (which redirects
 * by permission, audit C10) to save the hop: the calendar is the one admin
 * screen EVERY club role can open — it needs `bookings.view_all`, which
 * OWNER, MANAGER and STAFF all hold. Courts, pricing and staff are closed to
 * STAFF, so landing a front-desk account on any of them would be a 404 on
 * sign-in. A unit test pins every club role to that permission.
 */
export function clubHome(slug: string): string {
  return `/t/${slug}/admin/calendar`;
}

/** One membership, as the decision needs to see it. Plain data, so any caller can build one. */
export interface LandingMembership {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: Role;
  status: MembershipStatus;
  tenantStatus: TenantStatus;
  /** When the membership began. Breaks ties among clubs. */
  createdAt: Date;
}

export interface LandingOptions {
  /** Overrides COACH_HOME. Tests use it to show what the one-line change does. */
  coachHome?: CoachHome;
}

/**
 * Does this membership count at all?
 *
 * BOTH statuses, because either alone is a hole. An INVITED, SUSPENDED or
 * EXPIRED membership is a row that exists, not a role that is held —
 * `page-context` refuses them for the same reason. A club that is SUSPENDED or
 * CLOSED has no UI worth landing on, and `resolvePlayerTenant` already treats
 * it as not bookable.
 *
 * Written as equality with ACTIVE rather than exclusion of the known bad
 * values, so a status added to either enum later counts as NOT live until
 * somebody decides otherwise.
 */
function isLive(m: LandingMembership): boolean {
  return m.status === 'ACTIVE' && m.tenantStatus === 'ACTIVE';
}

/** Oldest membership first; the tenant id settles two made in the same millisecond. */
function byAge(a: LandingMembership, b: LandingMembership): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0)
  );
}

/** The club to land on: highest role, then oldest. A CLUB account has one. */
function firstClub(live: readonly LandingMembership[]): LandingMembership | undefined {
  return live
    .filter((m) => isClubRole(m.role))
    .sort(
      (a, b) =>
        CLUB_ROLE_RANK[a.role as ClubRole] - CLUB_ROLE_RANK[b.role as ClubRole] || byAge(a, b),
    )[0];
}

function firstCoaching(live: readonly LandingMembership[]): LandingMembership | undefined {
  return live.filter((m) => m.role === 'COACH').sort(byAge)[0];
}

export type LandingReason =
  | 'player'
  | 'club'
  /** A CLUB account whose one club is not live: suspended, closed, or its membership ended. */
  | 'club-unavailable'
  | 'coach'
  /** `accountKind` is NULL: #227's default, until a person decides the account. */
  | 'undecided';

export interface LandingDecision {
  href: string;
  reason: LandingReason;
  /** The club being landed on, when there is one — the header links back to it. */
  club: { tenantId: string; tenantSlug: string; tenantName: string } | null;
}

function landOn(m: LandingMembership, href: string, reason: LandingReason): LandingDecision {
  return {
    href,
    reason,
    club: { tenantId: m.tenantId, tenantSlug: m.tenantSlug, tenantName: m.tenantName },
  };
}

/**
 * THE DECISION. An account's kind and its non-player memberships in, a place
 * to land out.
 *
 * `memberships` need not include PLAYER rows: they decide nothing here, and
 * the read that feeds this skips them.
 */
export function decideLanding(
  input: { kind: AccountKind | null; memberships: readonly LandingMembership[] },
  opts: LandingOptions = {},
): LandingDecision {
  const coachHome = opts.coachHome === undefined ? COACH_HOME : opts.coachHome;
  const live = input.memberships.filter(isLive);

  switch (input.kind) {
    case 'PLAYER':
      return { href: PLAYER_HOME, reason: 'player', club: null };

    case 'CLUB': {
      const club = firstClub(live);
      return club
        ? landOn(club, clubHome(club.tenantSlug), 'club')
        : { href: HOME, reason: 'club-unavailable', club: null };
    }

    case 'COACH': {
      const coaching = coachHome ? firstCoaching(live) : undefined;
      return coaching && coachHome
        ? landOn(coaching, coachHome(coaching.tenantSlug), 'coach')
        : { href: PLAYER_HOME, reason: 'coach', club: null };
    }

    case null: {
      // ═══ UNDECIDED: #227'S DEFAULT, KEPT FOR THEM ALONE ═══
      //
      // These accounts held club roles at two or more clubs, or a coach role,
      // when #263 arrived, and the owner said not to decide them by rule. Until
      // a person does, they land where #227 landed them: the club UI over the
      // coach UI over the player UI, and among clubs the highest role, then the
      // oldest membership. Nothing about them changes by signing in.
      const club = firstClub(live);
      if (club) return landOn(club, clubHome(club.tenantSlug), 'undecided');

      const coaching = coachHome ? firstCoaching(live) : undefined;
      if (coaching && coachHome) {
        return landOn(coaching, coachHome(coaching.tenantSlug), 'undecided');
      }

      // ═══ NOTHING TO LAND ON: ASK (#360, audit U01) ═══
      //
      // A brand-new account (NULL since #360) or an old undecided one with no
      // live club or coach UI. It used to land on the player's bookings with
      // no explanation; it is asked "player or coach?" instead.
      return { href: KIND_CHOOSER_PATH, reason: 'undecided', club: null };
    }
  }
}

/**
 * Where `/t/[slug]` sends someone who holds `role` at that club.
 *
 * The club-scoped twin of `decideLanding`. Accepting an invite redirects to
 * `/t/[slug]`, and so does the club layout when a session has been revoked
 * mid-visit — and until this existed nothing was at that address, so both
 * ended on a 404.
 */
export function clubIndexTarget(role: Role, slug: string, opts: LandingOptions = {}): string {
  if (isClubRole(role)) return clubHome(slug);

  const coachHome = opts.coachHome === undefined ? COACH_HOME : opts.coachHome;
  if (role === 'COACH' && coachHome) return coachHome(slug);

  return PLAYER_HOME;
}

/**
 * Where to send someone after sign-in, when they asked to go somewhere.
 *
 * A deep link wins over landing by kind — somebody who clicked through from an
 * email to `/t/x/admin/staff` wants that page, not their default. But this
 * value arrives in a query string anyone can write, so it is accepted only as
 * a path on THIS origin, and anything else is dropped rather than repaired:
 *
 *   - `//evil.example` and `/\evil.example` are protocol-relative: a browser
 *     resolves both to another host.
 *   - a tab or newline is STRIPPED by the URL parser, so `/\t/evil.example`
 *     becomes `//evil.example` after this function has looked at it. Any
 *     control character or whitespace is refused outright.
 *   - dot segments are resolved BEFORE the result is checked: `/..//x` and
 *     `/%2e%2e//x` both normalise to `//x`, so the protocol-relative test runs
 *     on the normalised path as well as on the input.
 *   - an absolute URL is kept only if its origin is `appOrigin` exactly.
 *     next-auth hands back absolute URLs after a failed attempt — it rebuilds
 *     `callbackUrl` from its own cookie — and dropping those would lose the
 *     deep link on the retry.
 *
 * Returns null for "no destination of their own", which is also what the bare
 * home page (`/`) means: it was this page's own default until landing
 * existed, it is where next-auth falls back to, and treating it as a request
 * would send every owner to the home page after signing in. `/login` would
 * loop, and nobody navigates a browser to `/api/`.
 *
 * next-auth checks the final URL again in its `redirect` callback, so this is
 * the second line rather than the only one.
 */
export function safeCallbackPath(raw: unknown, appOrigin?: string | null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;

  // Control characters, space and DEL anywhere, and backslashes, which a
  // browser reads as a slash. A loop rather than a regex: the character class
  // for this is exactly what `no-control-regex` exists to question.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }

  const SENTINEL = 'https://callback.invalid';
  let url: URL;

  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return null;
    try {
      url = new URL(raw, SENTINEL);
    } catch {
      return null;
    }
    // Belt and braces: a relative path must not have moved us off the origin.
    if (url.origin !== SENTINEL) return null;
  } else {
    if (!appOrigin) return null;
    let expected: string;
    try {
      url = new URL(raw);
      expected = new URL(appOrigin).origin;
    } catch {
      return null;
    }
    if (url.origin !== expected) return null;
  }

  const { pathname } = url;
  // After normalisation, not just before: see the dot-segment note above.
  if (pathname.startsWith('//')) return null;
  if (pathname === '/') return null;
  if (pathname === '/login' || pathname.startsWith('/login/')) return null;
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;

  return `${pathname}${url.search}${url.hash}`;
}

/**
 * The post-sign-in destination for a `/login` visit.
 *
 * `next` is what this app writes (middleware, the club layout, the invite
 * page, `/me/bookings`); `callbackUrl` is what next-auth writes. Until #227 the
 * login page read only `callbackUrl`, so every `?next=` in the app was ignored
 * and a deep link through sign-in always ended on the home page — including
 * the invite page, which tells people "after signing in you will come back
 * here".
 *
 * Nothing usable → `/start`, which lands them by role.
 */
export function postSignInPath(
  params: { next?: unknown; callbackUrl?: unknown },
  appOrigin?: string | null,
): string {
  return (
    safeCallbackPath(params.next, appOrigin) ??
    safeCallbackPath(params.callbackUrl, appOrigin) ??
    START_PATH
  );
}
