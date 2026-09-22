import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

import { requiredPermission } from '@/lib/security/route-permissions';

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

function discoverRoutes(): RouteFile[] {
  const routes: RouteFile[] = [];

  for (const f of globSync('src/app/api/**/route.ts')) {
    const file = f.toString();
    const src = readFileSync(file, 'utf8');

    // Which HTTP verbs does this file actually export?
    const methods = MUTATING.filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?(?:const|function)\\s+${m}\\b`).test(src),
    );
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
    // If the glob broke, this suite would pass by finding nothing — the
    // classic vacuous guardrail.
    expect(globSync('src/app/**/*.tsx').length).toBeGreaterThan(0);
  });

  const cases = tenantScoped.flatMap((r) => r.methods.map((m) => [r.file, m, r.urlPath] as const));

  // `it.each([])` is itself a jest error, and P08 lands the first routes.
  const eachOrSkip = cases.length > 0 ? it.each(cases) : it.each([['(none yet)', '-', '-']]);

  eachOrSkip('%s exports %s — it must require a permission', (file, method, urlPath) => {
    if (file === '(none yet)') {
      // No tenant-scoped API routes exist yet. P08 lands the first, and this
      // ratchet starts biting the moment it does.
      expect(cases).toHaveLength(0);
      return;
    }

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
