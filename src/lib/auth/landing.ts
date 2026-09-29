import type { MembershipStatus, Role, TenantStatus } from '@prisma/client';

/**
 * Where a person lands after signing in, and which contexts they can switch
 * between (#227).
 *
 * ═══ ONE SIGN-IN, THREE UIs ═══
 *
 * Owner's decision: one identity, role-based landing. A coach at one club
 * plays at another; an owner books courts for themselves. So the question is
 * never "which account is this" but "which of this person's contexts do they
 * want right now" — and after sign-in, with nothing else to go on, this module
 * answers it:
 *
 *   roles held                    lands on
 *   ───────────────────────────   ──────────────────────────────────────
 *   none                          player UI
 *   PLAYER at one or more clubs   player UI
 *   OWNER / MANAGER / STAFF       club UI for that club
 *   COACH                         coach UI — the player UI until one exists
 *   several                       last used; with none, see DEFAULT below
 *
 * ═══ PURE, AND DELIBERATELY SO ═══
 *
 * No database, no request, no Node-only import — the only import is a TYPE,
 * which compiles away. Three callers need the same answer and must not each
 * grow their own copy of it:
 *
 *   - `/start`, the web's post-sign-in redirect;
 *   - the role switcher in the site header, which is a client component;
 *   - the iOS client, which will need the same decision over the API.
 *
 * The reads that feed it live in `@/app-layer/usecases/landing`.
 *
 * ═══ EVERYONE HOLDS THE PLAYER CONTEXT ═══
 *
 * Every signed-in person is a player: `PlayerProfile` is global and a
 * booking at any active club makes you a member of it (#229). So "player"
 * is not a membership to find, it is always there — which is why the rows
 * "none" and "PLAYER somewhere" land in the same place, and why anyone with
 * a club role holds at least two contexts. PLAYER memberships add nothing:
 * the player UI spans every club.
 *
 * ═══ DEFAULT, FOR SEVERAL CONTEXTS AND NOTHING REMEMBERED ═══
 *
 * A CHOICE THE OWNER MAY WANT TO REVISIT: the club UI wins over the player
 * UI, and within clubs the highest role (OWNER, then MANAGER, then STAFF)
 * wins, oldest membership first on a tie.
 *
 * Why the club UI and not the player UI: every club role holder also holds
 * the player context, so a player-first default would mean an owner NEVER
 * lands on their club until they have used the switcher once — the third row
 * of the table would never fire. Worse, since booking anywhere creates a
 * PLAYER membership, an owner's landing would flip the day they booked a
 * court at somebody else's club. Club-first is stable against that.
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
 * ═══ THE ONE LINE TO CHANGE WHEN THE COACH UI EXISTS ═══
 *
 * There is no coach UI: `usecases/coach.ts` has no route and `Coach.bio` says
 * so. Until there is, a coach lands on the player UI, and a COACH membership
 * contributes no entry to the switcher — an entry leading to the same page as
 * "player" would be two buttons that do one thing.
 *
 * When the coach UI ships, set this to its per-club home, e.g.
 *
 *   export const COACH_HOME: CoachHome = (slug) => `/t/${slug}/coach`;
 *
 * and coach landing, the switcher entry and the `/t/[slug]` index all follow.
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
 * Highest authority first. Used only to choose a DEFAULT among clubs; it
 * decides nothing about what anyone may do.
 */
const CLUB_ROLE_RANK: Readonly<Record<ClubRole, number>> = { OWNER: 0, MANAGER: 1, STAFF: 2 };

export function isClubRole(role: string): role is ClubRole {
  return Object.hasOwn(CLUB_ROLE_RANK, role);
}

/**
 * A club's landing page: the diary.
 *
 * There is no `/t/[slug]/admin` index to land on, and the calendar is the one
 * admin screen EVERY club role can open — it needs `bookings.view_all`, which
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
  /** When the membership began. Breaks ties in the default. */
  createdAt: Date;
}

/**
 * A place a person can be. `key` is what "last used" stores and what the
 * switcher sends back: `player`, `club:<tenantId>` or `coach:<tenantId>`.
 *
 * Keyed on the tenant ID, not the slug, so that renaming a club does not
 * silently orphan everybody's last-used entry for it.
 */
export type LandingContext =
  | { kind: 'player'; key: 'player'; href: string }
  | {
      kind: 'club';
      key: `club:${string}`;
      href: string;
      tenantId: string;
      tenantSlug: string;
      tenantName: string;
      role: ClubRole;
    }
  | {
      kind: 'coach';
      key: `coach:${string}`;
      href: string;
      tenantId: string;
      tenantSlug: string;
      tenantName: string;
    };

/**
 * Frozen because it is ONE object shared by every result: a caller that
 * edited the `href` on the one it was handed would otherwise re-route every
 * later decision in the process.
 */
export const PLAYER_CONTEXT: LandingContext = Object.freeze({
  kind: 'player' as const,
  key: 'player' as const,
  href: PLAYER_HOME,
});

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

function byName(a: { tenantName: string }, b: { tenantName: string }): number {
  return a.tenantName.localeCompare(b.tenantName);
}

/**
 * Every context this person holds, in the order the switcher shows them:
 * player first, then clubs by name, then coach contexts by name.
 */
export function landingContexts(
  memberships: readonly LandingMembership[],
  opts: LandingOptions = {},
): LandingContext[] {
  const coachHome = opts.coachHome === undefined ? COACH_HOME : opts.coachHome;

  const clubs: Extract<LandingContext, { kind: 'club' }>[] = [];
  const coaches: Extract<LandingContext, { kind: 'coach' }>[] = [];
  const seen = new Set<string>();

  for (const m of memberships) {
    if (!isLive(m)) continue;

    // `@@unique([userId, tenantId])` makes a second row per club impossible
    // from the database. A caller building this list by hand has no such
    // guarantee, and one club listed twice is two switcher entries to one place.
    if (seen.has(m.tenantId)) continue;
    seen.add(m.tenantId);

    const club = { tenantId: m.tenantId, tenantSlug: m.tenantSlug, tenantName: m.tenantName };

    if (isClubRole(m.role)) {
      clubs.push({
        kind: 'club',
        key: `club:${m.tenantId}`,
        href: clubHome(m.tenantSlug),
        ...club,
        role: m.role,
      });
    } else if (m.role === 'COACH' && coachHome) {
      coaches.push({
        kind: 'coach',
        key: `coach:${m.tenantId}`,
        href: coachHome(m.tenantSlug),
        ...club,
      });
    }
    // PLAYER, and any role this file has never heard of, adds nothing. For an
    // unknown role that is the safe direction: it earns no admin landing.
  }

  return [PLAYER_CONTEXT, ...clubs.sort(byName), ...coaches.sort(byName)];
}

export type LandingReason =
  /** The player context is all they hold — the first two rows of the table. */
  | 'only-context'
  /** Several contexts, and the one they last chose is still theirs. */
  | 'last-used'
  /** Several contexts, nothing usable remembered: see DEFAULT above. */
  | 'default';

export interface LandingDecision {
  context: LandingContext;
  /** Every context held, for the switcher. Always starts with the player context. */
  contexts: LandingContext[];
  reason: LandingReason;
}

/**
 * THE DECISION. Memberships plus last-used in, a place to land out.
 *
 * `lastUsed` is ADVISORY. It is honoured only when it names a context the
 * person holds right now, so a club they have left, been suspended from, or
 * that has itself been suspended since is ignored rather than obeyed — the
 * stored value is never authority, and cannot become a way into a club.
 */
export function decideLanding(
  input: { memberships: readonly LandingMembership[]; lastUsed?: string | null },
  opts: LandingOptions = {},
): LandingDecision {
  const contexts = landingContexts(input.memberships, opts);

  if (contexts.length === 1) {
    return { context: contexts[0]!, contexts, reason: 'only-context' };
  }

  const remembered = input.lastUsed ? contexts.find((c) => c.key === input.lastUsed) : undefined;
  if (remembered) return { context: remembered, contexts, reason: 'last-used' };

  return { context: defaultContext(input.memberships, contexts), contexts, reason: 'default' };
}

/**
 * Several contexts, nothing remembered. Club over coach over player; among
 * clubs, highest role, then the oldest membership, then the tenant ID so that
 * two memberships created in the same millisecond still order the same way
 * every time.
 */
function defaultContext(
  memberships: readonly LandingMembership[],
  contexts: readonly LandingContext[],
): LandingContext {
  const held = new Map(contexts.map((c) => [c.key, c]));

  const ranked = memberships
    .filter(isLive)
    .map((m) => {
      const club = held.get(`club:${m.tenantId}`);
      const coach = held.get(`coach:${m.tenantId}`);
      const context = club ?? coach;
      if (!context) return null;
      const rank = club && isClubRole(m.role) ? CLUB_ROLE_RANK[m.role] : 10;
      return { context, rank, createdAt: m.createdAt.getTime(), tenantId: m.tenantId };
    })
    .filter((r) => r !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.createdAt - b.createdAt ||
        (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0),
    );

  return ranked[0]?.context ?? PLAYER_CONTEXT;
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

function isWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Which context the page at `pathname` belongs to — what the switcher marks
 * as current.
 *
 * A club's context covers its whole admin area, not just the page it lands
 * on: someone on `/t/x/admin/courts` is in club x. Everything that is not a
 * club or coach area is the player's — the home page and venue discovery are
 * where a player starts, and there is nowhere else to be.
 */
export function contextForPath(
  contexts: readonly LandingContext[],
  pathname: string,
): LandingContext {
  for (const c of contexts) {
    if (c.kind === 'club' && isWithin(pathname, `/t/${c.tenantSlug}/admin`)) return c;
    if (c.kind === 'coach' && isWithin(pathname, c.href)) return c;
  }
  return contexts.find((c) => c.kind === 'player') ?? PLAYER_CONTEXT;
}

/**
 * Where to send someone after sign-in, when they asked to go somewhere.
 *
 * A deep link wins over role landing — somebody who clicked through from an
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
 * home page (`/`) means: it was this page's own default until role landing
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
