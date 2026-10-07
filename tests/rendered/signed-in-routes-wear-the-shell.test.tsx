import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { SWRConfig } from 'swr';

import ClubAdminLayout from '@/app/(app)/t/[slug]/admin/layout';
import PlatformLayout from '@/app/(app)/platform/layout';
import HomeLayout from '@/app/(home)/layout';
import PublicLayout from '@/app/(public)/layout';
import NotFound from '@/app/not-found';
import { SIGNED_IN_HOME } from '@/components/layout/nav-items';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LandingDecision } from '@/lib/auth/landing';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';
import { installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * EVERY SIGNED-IN PAGE WEARS INFLECT'S APPSHELL, FOR EVERY ACCOUNT KIND (#362).
 *
 * The owner, 2026-10-07: "make sure we use the inflect UI on all accounts:
 * club, player and coach". True today is not enough; this keeps it true.
 *
 * ═══ HOW ═══
 *
 * 1. The routes come from the FILESYSTEM: every `page.tsx` under src/app, so a
 *    new page is covered the day it lands. Each must sit under a layout that
 *    draws a signed-in frame (`FRAME_LAYOUTS`), or be on `NO_FRAME` with the
 *    reason it has none.
 * 2. Each frame layout is then RENDERED for a player, a coach, a club account
 *    and a moderator, with the reads it makes mocked to say who is asking, and
 *    must produce the vendored AppShell (`[data-app-shell]`), its left rail
 *    (the `<aside>` and its `nav`), and that kind's items: a player's or a
 *    coach's Играй · Резервации · Профил, a club account's own admin pages.
 *    Where the layout refuses the kind (a player on a club's admin, anybody
 *    without a grant on /platform), it answers `notFound()`, and the root 404
 *    is rendered instead: it too must be the kind's own frame.
 *
 * ═══ WHY THIS LAYER ═══
 *
 * A rendered test of the LAYOUTS, not an E2E run over the routes. The frame is
 * decided entirely in the layouts, from four reads (the session, the landing,
 * the grant, the membership), so mocking those reads covers every kind at
 * every route in seconds, deterministically, in the CI job every PR runs
 * (unit + rendered). An E2E run would need a seeded account of each kind and
 * a production build for ~30 routes × 4 kinds, in the slower E2E job, to
 * prove the same thing; tests/e2e/player-shell.spec.ts and its mobile twin
 * prove the browser half (the rail visible at 1280 px, the drawer and the bar
 * at 393 px) on representative pages instead. The `guardrails` project is
 * node-only and renders nothing, so this lives in `rendered`.
 */

// ── The routes, from the filesystem ───────────────────────────────────

const APP = 'src/app';

/** The layouts that draw a signed-in frame, and the frame component each renders. */
const FRAME_LAYOUTS: Record<string, string> = {
  '(public)/layout.tsx': 'PlayerChrome',
  '(app)/t/[slug]/admin/layout.tsx': 'ClubAdminShell',
  '(app)/platform/layout.tsx': 'ClubAdminShell',
};

/** Page directories (relative to src/app) with no frame, and why. Shrink it; never pad it. */
const NO_FRAME: Record<string, string> = {
  '(home)':
    'signed in, its layout redirects to Играй (SIGNED_IN_HOME), whose page wears the frame: asserted below',
  '(app)/start/kind':
    'the kind chooser (#360): until an account has chosen, nothing is offered but signing out',
  '(app)/t/[slug]':
    "redirect-only index: a member goes on to the club's admin, anybody else to the club page or a 404, each in a frame",
  offline:
    'force-static and served by the service worker: there is no request, so no session to draw a frame for',
  '(design)/design-system': 'developer-facing component gallery, not linked from the app',
};

const PAGES = globSync(`${APP}/**/page.tsx`)
  .map((f) => path.relative(APP, path.dirname(f.toString())).split(path.sep).join('/'))
  .map((dir) => (dir === '' ? '.' : dir))
  .sort();

/** Every layout above (and beside) a page, root first, as paths relative to src/app. */
function layoutsOf(dir: string): string[] {
  const parts = dir === '.' ? [] : dir.split('/');
  return Array.from({ length: parts.length + 1 }, (_, i) =>
    [...parts.slice(0, i), 'layout.tsx'].join('/'),
  ).filter((l) => existsSync(path.join(APP, l)));
}

/** `(public)/venues/[slug]` → `^/venues/[^/]+$`. */
function routePattern(dir: string): RegExp {
  const segments = dir
    .split('/')
    .filter((s) => s && s !== '.' && !/^\(.*\)$/.test(s))
    .map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&')));
  return new RegExp(`^/${segments.join('/')}$`);
}

describe('every page sits under a signed-in frame, or says why not', () => {
  it('the scan is not vacuous', () => {
    expect(PAGES.length).toBeGreaterThan(25);
    expect(PAGES).toEqual(
      expect.arrayContaining([
        '(public)/venues',
        '(public)/me/bookings',
        '(app)/t/[slug]/admin/calendar',
        '(app)/platform/moderation',
      ]),
    );
  });

  it.each(PAGES.filter((p) => !(p in NO_FRAME)))('%s is drawn inside a frame layout', (dir) => {
    const frames = layoutsOf(dir).filter((l) => l in FRAME_LAYOUTS);
    expect({ dir, frames: frames.length > 0 }).toEqual({ dir, frames: true });
  });

  it.each(Object.entries(NO_FRAME))('%s: a stated reason, and still a page', (dir, why) => {
    expect(PAGES).toContain(dir);
    expect(why.length).toBeGreaterThan(40);
  });

  it.each(Object.entries(FRAME_LAYOUTS))('%s renders %s', (file, frame) => {
    expect(readFileSync(path.join(APP, file), 'utf8')).toMatch(new RegExp(`<${frame}\\b`));
  });

  it('Играй, where `/` sends a signed-in account, is itself a framed page', () => {
    const home = PAGES.find((p) => routePattern(p).test(SIGNED_IN_HOME));
    expect(home).toBeDefined();
    expect(layoutsOf(home!).some((l) => l in FRAME_LAYOUTS)).toBe(true);
  });
});

// ── The frames, rendered per account kind ─────────────────────────────

jest.mock('next-auth/react', () => ({ signOut: jest.fn() }));

class Refused extends Error {
  constructor(
    readonly how: 'notFound' | 'redirect',
    readonly to?: string,
  ) {
    super(`${how} ${to ?? ''}`);
  }
}
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  usePathname: () => '/venues',
  useSelectedLayoutSegment: () => null,
  useParams: () => ({ slug: 'sofia-padel' }),
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
  notFound: () => {
    throw new Refused('notFound');
  },
  redirect: (to: string) => {
    throw new Refused('redirect', to);
  },
}));

const signedInIdentity = jest.fn();
const resolveTenantPageContext = jest.fn();
jest.mock('@/lib/auth/page-context', () => ({
  signedInIdentity: () => signedInIdentity(),
  resolveTenantPageContext: (slug: string) => resolveTenantPageContext(slug),
}));
const resolveLanding = jest.fn();
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: (...a: unknown[]) => resolveLanding(...a),
}));
const resolvePlatformAuthority = jest.fn();
jest.mock('@/lib/auth/platform-admin', () => ({
  resolvePlatformAuthority: (...a: unknown[]) => resolvePlatformAuthority(...a),
}));
jest.mock('@/lib/modules', () => ({ readModules: () => ({ openPlay: false, messaging: false }) }));
jest.mock('@/app-layer/usecases/club-nouns', () => ({ clubResourceNouns: async () => 'court' }));

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const messages = (await import('../../messages/bg.json')).default as unknown;
    const scope = ns
      .split('.')
      .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], messages) as
      Record<string, unknown> | undefined;
    return (key: string, values?: Record<string, string | number>) => {
      // A dotted key is a nested one, as next-intl reads it (`track.courts`).
      const value = key
        .split('.')
        .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], scope);
      if (typeof value !== 'string') return `${ns}.${key}`;
      return Object.entries(values ?? {}).reduce(
        (s, [k, v]) => s.replace(`{${k}}`, String(v)),
        value,
      );
    };
  },
}));

const n = bg.common.nav;
const SLUG = 'sofia-padel';
const ME = { userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' };

interface Kind {
  landing: LandingDecision;
  capabilities: string[];
  /** The membership the club layout reads for SLUG. */
  membership: unknown;
  /** The rail's links this kind must see, and links it must never see. */
  sees: string[];
  never: RegExp;
}

const PLAYER_RAIL = ['/venues', '/me/bookings', '/me/profile'];
const CLUB_RAIL = [
  `/t/${SLUG}/admin/calendar`,
  `/t/${SLUG}/admin/courts`,
  `/t/${SLUG}/admin/pricing`,
  `/t/${SLUG}/admin/photos`,
  `/t/${SLUG}/admin/players`,
  `/t/${SLUG}/admin/staff`,
  `/t/${SLUG}/admin/reports`,
];
const NOT_A_MEMBER = { kind: 'not-a-member' };

const KINDS: Record<'player' | 'coach' | 'club' | 'moderator', Kind> = {
  player: {
    landing: { href: '/me/bookings', reason: 'player', club: null },
    capabilities: [],
    membership: NOT_A_MEMBER,
    sees: PLAYER_RAIL,
    never: /^\/(t\/|platform)/,
  },
  coach: {
    landing: { href: '/me/bookings', reason: 'coach', club: null },
    capabilities: [],
    membership: NOT_A_MEMBER,
    sees: PLAYER_RAIL,
    never: /^\/(t\/|platform)/,
  },
  club: {
    landing: {
      href: `/t/${SLUG}/admin/calendar`,
      reason: 'club',
      club: { tenantId: 'c1', tenantSlug: SLUG, tenantName: 'Sofia Padel' },
    },
    capabilities: [],
    membership: {
      kind: 'ok',
      ctx: {
        userId: 'u1',
        tenantId: 'c1',
        tenantSlug: SLUG,
        tenantName: 'Sofia Padel',
        role: 'OWNER',
        permissions: getPermissionsForRole('OWNER'),
      },
    },
    sees: CLUB_RAIL,
    // One account, one kind: never the player's sidebar.
    never: /^\/(venues|me\/)/,
  },
  moderator: {
    landing: { href: '/me/bookings', reason: 'player', club: null },
    capabilities: ['REVIEW_MODERATE'],
    membership: NOT_A_MEMBER,
    sees: [...PLAYER_RAIL, '/platform/moderation', '/platform/security'],
    never: /^\/t\//,
  },
};

/** Where each frame layout is mounted, and how it is called. */
const LAYOUTS: Record<string, (children: ReactNode) => Promise<ReactNode> | ReactNode> = {
  '(public)/layout.tsx': (children) => PublicLayout({ children }),
  '(app)/t/[slug]/admin/layout.tsx': (children) =>
    ClubAdminLayout({ children, params: Promise.resolve({ slug: SLUG }) }),
  '(app)/platform/layout.tsx': (children) => PlatformLayout({ children }),
};

/** What a page under `layout` gives `kind`: the layout's frame, or the root 404's. */
async function frameFor(layout: string): Promise<{ tree: ReactNode; refused: boolean }> {
  const page = <p data-testid="the-page">page</p>;
  try {
    return { tree: await resolveServerTree(await LAYOUTS[layout]!(page)), refused: false };
  } catch (err) {
    if (!(err instanceof Refused) || err.how !== 'notFound') throw err;
    return { tree: await resolveServerTree(await NotFound()), refused: true };
  }
}

function renderTree(tree: ReactNode) {
  return render(
    withIntl(
      <SWRConfig value={{ provider: () => new Map() }}>
        <KeyboardShortcutProvider>
          <TooltipProvider>{tree as ReactElement}</TooltipProvider>
        </KeyboardShortcutProvider>
      </SWRConfig>,
    ),
  );
}

beforeEach(() => {
  installFakeFetch(() => ok({ items: [], nextCursor: null, unreadCount: 0 }));
  signedInIdentity.mockResolvedValue(ME);
});

describe.each(Object.keys(LAYOUTS))('%s', (layout) => {
  it.each(Object.keys(KINDS) as (keyof typeof KINDS)[])(
    'a %s gets the AppShell, its left rail and its own items',
    async (name) => {
      const kind = KINDS[name];
      resolveLanding.mockResolvedValue(kind.landing);
      resolvePlatformAuthority.mockResolvedValue({
        grantId: kind.capabilities.length ? 'g1' : null,
        capabilities: kind.capabilities,
      });
      resolveTenantPageContext.mockResolvedValue(kind.membership);

      const { tree, refused } = await frameFor(layout);
      const { container } = renderTree(tree);

      expect(container.querySelector('[data-app-shell]')).not.toBeNull();
      const rail = screen.getByRole('complementary');
      const nav = within(rail).getByRole('navigation', { name: bg.common.ui.mainNav });
      const hrefs = within(nav)
        .queryAllByRole('link')
        .map((l) => l.getAttribute('href') ?? '');

      // On /platform a grant holder is in the platform's own shell, whose
      // rail is the platform's pages; everywhere else it is the kind's own.
      const platformShell = layout.startsWith('(app)/platform') && !refused;
      const expected = platformShell ? ['/platform/moderation', '/platform/security'] : kind.sees;
      expect({ name, layout, hrefs }).toEqual({ name, layout, hrefs: expected });
      if (!platformShell) {
        expect(hrefs.filter((h) => kind.never.test(h))).toEqual([]);
      }
      // One <main>, the frame's, around whatever the route rendered.
      expect(screen.getAllByRole('main')).toHaveLength(1);
      // The public header is the signed-out visitor's alone.
      expect(screen.queryByRole('link', { name: bg.login.title })).not.toBeInTheDocument();
      expect(screen.queryByTestId('site-footer')).not.toBeInTheDocument();
      // A refused page is the root 404, and a page that was not refused is the page.
      expect(screen.queryByTestId('the-page') !== null).toBe(!refused);
    },
  );
});

describe('the one route with no frame of its own for a signed-in account: `/`', () => {
  it.each(Object.keys(KINDS) as (keyof typeof KINDS)[])(
    'a %s is sent to Играй before anything renders',
    async (name) => {
      resolveLanding.mockResolvedValue(KINDS[name].landing);
      await expect(HomeLayout({ children: null })).rejects.toEqual(
        new Refused('redirect', SIGNED_IN_HOME),
      );
    },
  );

  it('a visitor is not: the landing in the public chrome', async () => {
    signedInIdentity.mockResolvedValue(null);
    renderTree(await resolveServerTree(await HomeLayout({ children: <p>landing</p> })));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: bg.login.title }),
    ).toHaveAttribute('href', '/login');
  });
});

describe('the scan would catch a page with no frame', () => {
  it('a page outside every frame layout has none', () => {
    expect(layoutsOf('(app)/start/kind').some((l) => l in FRAME_LAYOUTS)).toBe(false);
    expect(layoutsOf('(public)/me/profile')).toContain('(public)/layout.tsx');
  });

  it('a club account’s items are not a player’s, and the other way round', () => {
    expect(KINDS.club.sees.some((h) => KINDS.club.never.test(h))).toBe(false);
    expect(KINDS.player.sees.some((h) => KINDS.player.never.test(h))).toBe(false);
    expect(PLAYER_RAIL.every((h) => KINDS.club.never.test(h))).toBe(true);
    expect(n.play).toBeTruthy();
  });
});
