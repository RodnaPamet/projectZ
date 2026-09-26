import { globSync, readFileSync } from 'node:fs';

import { checkPublicRoute, checkTenantAccess } from '@/lib/auth/guard';

import { exportsMethod } from '../helpers/route-exports';

/**
 * THE SPEC AND THE EDGE GUARD AGREE ABOUT WHO MAY CALL WITHOUT A TOKEN.
 *
 * ═══ TWO SOURCES OF TRUTH THAT NEVER SPOKE ═══
 *
 * `openapi/playerz-v1.json` declares `security: []` on the operations a client
 * may call unauthenticated. `PUBLIC_PATTERNS` in `src/lib/auth/guard.ts`
 * declares the paths the edge lets through without a token. Nothing compared
 * them, and they disagreed on five of seven:
 *
 *   /api/v1/venues, /venues/near, /venues/{id}, /venues/{id}/availability
 *   /api/v1/realtime/subscribe
 *
 * All five reached anonymous callers anyway — `tenantSlugFromPath` finds no
 * slug, and `checkTenantAccess` falls through to `{ kind: 'allow' }`. So
 * nothing was broken and nothing would have told anyone.
 *
 * That default is the one `guard.ts` warns about by name for `/login`, and the
 * one several comments in that file anticipate tightening. The day it is
 * tightened, unauthenticated venue discovery starts demanding a token, the
 * native client's first screen breaks, and the failure appears nowhere near the
 * change that caused it.
 *
 * ═══ AND THE OTHER DIRECTION, WHICH IS THE DANGEROUS ONE ═══
 *
 * A path marked public that the spec says needs a token is a hole: the edge
 * stops checking membership for it. That cannot be reasoned about from one file
 * either, so it is asserted here too.
 *
 * ═══ WHAT `public` DOES NOT SKIP ═══
 *
 * The mutation permission check. `middleware.ts` treats `public` and `allow`
 * identically at that switch and falls through to `requiredPermission`. Worth
 * knowing before adding a prefix here: it opens the tenant check, not
 * authorisation generally.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface Op {
  security?: unknown[];
}

const spec = JSON.parse(readFileSync('openapi/playerz-v1.json', 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
};

/** `/venues/{id}` → `/api/v1/venues/sample` — a path the matchers can be run on. */
function toUrl(specPath: string): string {
  return `/api/v1${specPath.replace(/\{[^}]+\}/g, 'sample')}`;
}

const operations = Object.entries(spec.paths).flatMap(([path, ops]) =>
  Object.entries(ops)
    .filter(([m]) => METHODS.includes(m.toUpperCase() as (typeof METHODS)[number]))
    .map(([m, op]) => ({
      path,
      url: toUrl(path),
      method: m.toUpperCase(),
      // Three cases, and the middle one is easy to get wrong:
      //
      //   security: []                    no scheme applies — anonymous
      //   security: [{}, {bearerAuth:[]}] OPTIONAL — an empty requirement
      //                                   object means "or nothing". Logout is
      //                                   this: it uses a token when sent and
      //                                   always answers 204 without one.
      //   security: [{bearerAuth: []}]    required
      //   (absent)                        inherits the document default, which
      //                                   is bearerAuth — so required
      //
      // Treating optional as "requires a token" is what first made this suite
      // fail on logout, where the EDGE was right and the spec was wrong.
      anonymous:
        Array.isArray(op.security) &&
        (op.security.length === 0 ||
          op.security.some(
            (r) => r !== null && typeof r === 'object' && Object.keys(r).length === 0,
          )),
    })),
);

describe('public routes match the spec', () => {
  it('found operations of both kinds, so neither assertion is vacuous', () => {
    // A document that failed to parse, or a `security` key that got renamed,
    // would otherwise make every loop below iterate nothing.
    expect(operations.length).toBeGreaterThanOrEqual(15);
    expect(operations.filter((o) => o.anonymous).length).toBeGreaterThanOrEqual(5);
    expect(operations.filter((o) => !o.anonymous).length).toBeGreaterThanOrEqual(10);
  });

  it('every operation the spec says needs no token is EXPLICITLY public', () => {
    // Explicitly: `kind === 'public'`, not `'allow'`. Reaching the route via the
    // no-slug fall-through is the accident this exists to convert into a
    // decision.
    const implicit = operations
      .filter((o) => o.anonymous)
      .filter((o) => !checkPublicRoute(o.url))
      .map((o) => `${o.method} ${o.path}  (${o.url})`);

    if (implicit.length > 0) {
      throw new Error(
        `The spec marks these \`security: []\` but PUBLIC_PATTERNS does not list them:\n\n` +
          implicit.map((i) => `  ${i}`).join('\n') +
          `\n\nThey probably still work, via \`if (!slug) return allow\` in checkTenantAccess —\n` +
          `which is the fail-open default that file tightens everywhere else. Add a pattern\n` +
          `to PUBLIC_PATTERNS so it is a decision, or drop \`security: []\` from the spec.`,
      );
    }
  });

  it('nothing public is something the spec says needs a token', () => {
    // The dangerous direction. A prefix added here opens the tenant check for
    // everything under it, and prefixes are easy to write wider than intended.
    const overreach = operations
      .filter((o) => !o.anonymous)
      .filter((o) => checkPublicRoute(o.url))
      .map((o) => `${o.method} ${o.path}  (${o.url})`);

    if (overreach.length > 0) {
      throw new Error(
        `PUBLIC_PATTERNS matches operations the spec says require a token:\n\n` +
          overreach.map((o) => `  ${o}`).join('\n') +
          `\n\nA public path skips the tenant membership check at the edge. If this is\n` +
          `deliberate, say so in the PR and change the spec to match; if it is a prefix\n` +
          `that reaches further than intended, narrow it.`,
      );
    }
  });

  it('an anonymous request to each of them is answered, not challenged', () => {
    // The property that actually matters to a client, asserted end to end
    // through the same function middleware calls.
    for (const op of operations.filter((o) => o.anonymous)) {
      expect({ path: op.path, kind: checkTenantAccess(op.url, null).kind }).toEqual({
        path: op.path,
        kind: 'public',
      });
    }
  });

  it('the platform tree is never public, whatever else changes', () => {
    // It is the one tree where the fall-through would be an outright hole, and
    // it has no spec operation marked anonymous — so the loops above would stay
    // silent if a pattern were ever widened to cover it.
    for (const url of ['/api/v1/platform/audit', '/api/v1/platform/tenants']) {
      expect(checkPublicRoute(url)).toBe(false);
      expect(checkTenantAccess(url, null).kind).toBe('unauthenticated');
    }
  });

  it('every spec path with an anonymous operation is a route that exists', () => {
    // Otherwise a renamed route leaves an entry that opens a path serving
    // nothing, and the assertions above keep passing.
    const routes = new Set(
      globSync('src/app/api/v1/**/route.ts').map((f) =>
        f
          .toString()
          .replace(/^src\/app\/api\/v1\//, '')
          .replace(/\/route\.ts$/, ''),
      ),
    );

    for (const op of operations.filter((o) => o.anonymous)) {
      const key = op.path.replace(/^\//, '').replace(/\{([^}]+)\}/g, '[$1]');
      expect({ path: op.path, exists: routes.has(key) }).toEqual({ path: op.path, exists: true });
    }
  });

  it('each of those routes really mounts the verb the spec marks anonymous', () => {
    // `security: []` on a verb the file does not export would be a promise
    // about nothing.
    for (const op of operations.filter((o) => o.anonymous)) {
      const file = `src/app/api/v1/${op.path.replace(/^\//, '').replace(/\{([^}]+)\}/g, '[$1]')}/route.ts`;
      expect({
        op: `${op.method} ${op.path}`,
        mounts: exportsMethod(readFileSync(file, 'utf8'), op.method),
      }).toEqual({ op: `${op.method} ${op.path}`, mounts: true });
    }
  });
});
