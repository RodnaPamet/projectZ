import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

import { requiredPermission } from '@/lib/security/route-permissions';

import { exportsMethod } from '../helpers/route-exports';

/**
 * DEFAULT-DENY RATCHET.
 *
 * The way an unprotected admin endpoint ships is never a decision. It is an
 * omission: somebody adds `POST /api/t/[slug]/admin/refunds`, and simply
 * does not think about the permission table. Nothing fails. The route works
 * beautifully — for everyone.
 *
 * So the build asserts it: every MUTATING route handler under
 * `/api/t/[slug]/` must resolve to a permission. A new one with no rule
 * fails here, by name, with the fix spelled out.
 *
 * Reads are deliberately exempt — they are gated by RLS (which returns zero
 * rows for the wrong tenant) plus the route's own logic.
 */

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface RouteFile {
  file: string;
  urlPath: string;
  methods: string[];
}

/**
 * ONE definition, used by discovery AND by the check that discovery works.
 * They were two separate literals, and they disagreed.
 */
const ROUTE_GLOB = 'src/app/api/**/route.ts';

function discoverRoutes(): RouteFile[] {
  const routes: RouteFile[] = [];

  for (const f of globSync(ROUTE_GLOB)) {
    const file = f.toString();
    const src = readFileSync(file, 'utf8');

    // Which HTTP verbs does this file actually mount? Both spellings — see
    // tests/helpers/route-exports.ts, which openapi-coverage now shares.
    const methods = MUTATING.filter((m) => exportsMethod(src, m));
    if (methods.length === 0) continue;

    // src/app/api/t/[slug]/bookings/route.ts -> /api/t/:slug/bookings
    const urlPath = file
      .replace(/^src\/app/, '')
      .replace(/\/route\.ts$/, '')
      .replace(/\[([^\]]+)\]/g, 'x'); // a concrete segment for matching

    routes.push({ file, urlPath, methods });
  }

  return routes;
}

const routes = discoverRoutes();

/**
 * `/api/t/:slug/...` and the versioned form `/api/v1/t/:slug/...`.
 *
 * This filter decides what the ratchet even LOOKS at, so narrowing it is
 * indistinguishable from passing. A literal `startsWith('/api/t/')` would
 * let the entire `/api/v1` tree ship unguarded with a green build — the
 * exact omission this suite exists to catch, one level up.
 */
const TENANT_SCOPED = /^\/api\/(?:v\d+\/)?t\//;

describe('route permission coverage (default deny)', () => {
  const tenantScoped = routes.filter((r) => TENANT_SCOPED.test(r.urlPath));

  it('the discovery actually walks the route tree', () => {
    // ═══ THIS MUST ASSERT ON THE GLOB DISCOVERY USES ═══
    //
    // It used to assert `globSync('src/app/**/*.tsx').length > 0` — page
    // components, which discovery never looks at. Nothing tied the two, so the
    // guard against vacuity was itself vacuous: repointing discovery at
    // `route.tsx` (zero matches) left every real route unexamined and this
    // suite reporting 2 passed, including this very test.
    expect(globSync(ROUTE_GLOB).length).toBeGreaterThanOrEqual(10);

    // And the route tree must actually contain tenant-scoped mutating routes.
    // A discovery that finds files but classifies none of them is the same
    // failure wearing a different hat.
    expect(tenantScoped.length).toBeGreaterThanOrEqual(3);
  });

  const cases = tenantScoped.flatMap((r) => r.methods.map((m) => [r.file, m, r.urlPath] as const));

  // The `(none yet)` placeholder that used to live here dated from before any
  // tenant route existed, and its body asserted `cases.length === 0` — which
  // is trivially true precisely when discovery has broken. It converted the
  // one symptom worth alarming on into a passing test. Routes exist now, so an
  // empty `cases` is a broken scan and the assertion above fails on it.
  const eachCase = it.each(cases);

  eachCase('%s exports %s — it must require a permission', (file, method, urlPath) => {
    const needed = requiredPermission(urlPath, method);

    if (!needed) {
      throw new Error(
        `${file} exports ${method} but no rule in ROUTE_PERMISSIONS matches ` +
          `"${urlPath}".\n\n` +
          `A mutating tenant route with no permission rule is open to every ` +
          `authenticated member of that tenant — including PLAYERs.\n\n` +
          `Fix: add a rule to src/lib/security/route-permissions.ts. If the ` +
          `route is genuinely meant to be open to any member, say so with an ` +
          `explicit rule naming the weakest permission that member holds.`,
      );
    }

    expect(needed).toBeTruthy();
  });
});
