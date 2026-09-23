import { readFileSync, existsSync, globSync } from 'node:fs';

/**
 * EVERY ROUTE BINDS ITS DATABASE HANDLE.
 *
 * ═══ THE OUTAGE THIS PREVENTS ═══
 *
 * A route that reaches for the raw Prisma singleton runs as whatever role
 * DATABASE_URL names, with no `SET LOCAL ROLE` and no `app.tenant_id`.
 *
 * In development that is a cluster SUPERUSER, which is exempt from row security
 * entirely, so the route works perfectly and returns every row. In production,
 * against the least-privileged role from P24, the same code either fails with
 * "permission denied" or — bound as app_user with no tenant — returns ZERO ROWS
 * WITH NO ERROR.
 *
 * An empty list is not a visible failure. `GET /venues?city=Sofia` returning
 * `[]` reads as "no venues in Sofia", and nothing in the logs disagrees.
 *
 * Three routes shipped exactly this: /api/venues, /api/venues/near and the
 * Stripe webhook, which would have silently updated nothing.
 *
 * So: a route file may not import the singleton. It goes through one of the
 * three bindings, each of which states which RLS context it is asking for.
 */

const BINDINGS =
  /\b(runInTenantContext|runInUserContext|runAsUserOnly|runAsSuperuser|inTenant|asUser|asSuperuser)\b/;

/**
 * Deliberate carve-outs. Each names WHY, because an exemption list with no
 * reasons is where violations go to be forgotten.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/app/api/ready/route.ts',
    why:
      'Connectivity probe only: `prisma.$queryRaw`SELECT 1``. It touches no table, ' +
      'so there is no row security to apply — and it must answer even when the ' +
      'app roles are misconfigured, since that is precisely what it exists to report.',
  },
];

const EXEMPT_FILES = new Set(EXEMPT.map((e) => e.file));

const ROUTES = globSync('src/app/api/**/route.ts')
  .map((f) => f.toString())
  // `_lib` is a Next private folder and is never routed.
  .filter((f) => !f.includes('/_lib/'));

describe('route database bindings', () => {
  it('the scan found the routes', () => {
    // A broken glob would make every assertion below vacuous.
    expect(ROUTES.length).toBeGreaterThan(5);
    expect(ROUTES).toContain('src/app/api/venues/route.ts');
  });

  it('every exemption points at a file that still exists', () => {
    // An exemption for a deleted path is a hole waiting for someone to recreate
    // that file, and it would never fail on its own.
    for (const { file } of EXEMPT) expect(existsSync(file)).toBe(true);
  });

  it.each(ROUTES.filter((f) => !EXEMPT_FILES.has(f)))(
    '%s does not use the raw Prisma singleton',
    (file) => {
      const src = readFileSync(file, 'utf8');
      const importsSingleton = /from '@\/lib\/db\/prisma'/.test(src);

      if (importsSingleton) {
        throw new Error(
          `${file} imports the raw Prisma client.\n\n` +
            `It will run with no RLS context: as a superuser in dev (every row), ` +
            `and as a least-privileged role in production (permission denied, or ` +
            `zero rows with no error).\n\n` +
            `Use inTenant / asUser / asSuperuser from src/app/api/v1/_lib/bind.ts, ` +
            `or runInTenantContext / runAsSuperuser directly. If this route ` +
            `genuinely touches no table, add it to EXEMPT with the reason.`,
        );
      }
    },
  );

  it.each(ROUTES.filter((f) => !EXEMPT_FILES.has(f)))(
    '%s names the RLS context it wants',
    (file) => {
      const src = readFileSync(file, 'utf8');

      // A route that touches no database at all is fine — health, metrics.
      // One that does must say which context, rather than inheriting whatever
      // the connection happens to be.
      const touchesDb = /\b(db|prisma|tx)\b/.test(src) && /@\/app-layer|@\/lib\/db/.test(src);
      if (!touchesDb) return;

      expect(BINDINGS.test(src)).toBe(true);
    },
  );
});
