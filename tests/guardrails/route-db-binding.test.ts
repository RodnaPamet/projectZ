import { readFileSync, existsSync, globSync } from 'node:fs';

/**
 * EVERY SERVER-SIDE ENTRY POINT BINDS ITS DATABASE HANDLE.
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
 * So: a file under src/app may not import the singleton. It goes through one of
 * the bindings, each of which states which RLS context it is asking for.
 *
 * ═══ WHY THIS SCANS PAGES TOO ═══
 *
 * It did not, and `/venues` — a server component, not a route — shipped the
 * same defect and was found by hand rather than by this file. A page is an
 * entry point like any other: it runs on the server, it reaches the same
 * repositories, and an unbound read there renders an empty city instead of
 * returning an empty JSON array.
 *
 * Pages do NOT use the bind.ts helpers, which take a RequestContext a page does
 * not have. They call runInTenantContext / runAsSuperuser directly, which is
 * why the check is on the binding rather than on a particular import.
 */

const BINDINGS =
  /\b(runInTenantContext|runInUserContext|runAsUserOnly|runAsSuperuser|inTenant|asUser|asSuperuser)\b/;

/**
 * Deliberate carve-outs. Each names WHY, because an exemption list with no
 * reasons is where violations go to be forgotten.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/app/api/cron/release-expired-bookings/route.ts',
    why:
      'Hands the singleton STRAIGHT to `releaseExpiredBookings`, which binds it ' +
      'itself: every database access in that use case is inside `runAsSuperuser`, ' +
      'and the route performs none of its own. It cannot bind here instead, ' +
      'because the sweep opens one SERIALIZABLE transaction PER BOOKING for the ' +
      'credit-ledger reversal, and isolation can only be set on the outermost ' +
      'BEGIN — a route that opened the transaction would silently downgrade it ' +
      'to a SAVEPOINT. The sweep verifies its own isolation on the first booking ' +
      'of every run and refuses to continue if it was handed an open transaction.',
  },
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

/**
 * Everything else under src/app: pages, layouts, and anything co-located with
 * them. `.tsx` as well as `.ts`, deliberately — the query-shape ratchet globs
 * `src/app/**\/*.ts` only, so `page.tsx` is invisible to that one, and a scan
 * that stops at the extension is how a server component goes unread.
 */
const SERVER_COMPONENTS = globSync(['src/app/**/*.ts', 'src/app/**/*.tsx'])
  .map((f) => f.toString())
  .filter((f) => !f.includes('/api/'));

const SCANNED = [...ROUTES, ...SERVER_COMPONENTS];

/**
 * Comment lines removed, so the binding check reads CODE.
 *
 * Not cosmetic: the fixed venues page explains its choice of binding in prose,
 * and a scan over raw text would then accept that page even if the call itself
 * were reverted to the singleton. Whole comment lines only — a `//` inside a
 * string is left alone, because cutting there could delete a real call.
 */
function codeOnly(src: string): string {
  let inBlock = false;

  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        return false;
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true;
        return false;
      }
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

describe('app-router database bindings', () => {
  it('the scan found the routes', () => {
    // A broken glob would make every assertion below vacuous.
    expect(ROUTES.length).toBeGreaterThan(5);
    expect(ROUTES).toContain('src/app/api/venues/route.ts');
  });

  it('the scan found the server components', () => {
    // Same reason, and specifically the page that shipped the defect: a glob
    // that silently matched nothing would pass every assertion below.
    expect(SERVER_COMPONENTS.length).toBeGreaterThan(3);
    expect(SERVER_COMPONENTS).toContain('src/app/(public)/venues/page.tsx');
  });

  it('every exemption points at a file that still exists', () => {
    // An exemption for a deleted path is a hole waiting for someone to recreate
    // that file, and it would never fail on its own.
    for (const { file } of EXEMPT) expect(existsSync(file)).toBe(true);
  });

  it('the cron sweep exemption still rests on the use case binding for it', () => {
    // The exemption is granted on a claim about ANOTHER file: that
    // `releaseExpiredBookings` binds every access itself. If that stops being
    // true, this route becomes an unbound singleton call with a written excuse
    // — the exact shape the exemption list is supposed to make impossible.
    const useCase = readFileSync('src/app-layer/usecases/release-expired-bookings.ts', 'utf8');

    expect(BINDINGS.test(useCase)).toBe(true);
    // And it must still be the one asking for the isolation the ledger needs.
    expect(useCase).toMatch(/isolationLevel: 'Serializable'/);

    // The route itself must still do nothing but pass the client through.
    const route = readFileSync('src/app/api/cron/release-expired-bookings/route.ts', 'utf8');
    expect(route).toMatch(/releaseExpiredBookings\(prisma\)/);
    // No model access of its own — that is what the exemption claims.
    expect(route).not.toMatch(/prisma\.\w+\./);
  });

  it.each(SCANNED.filter((f) => !EXEMPT_FILES.has(f)))(
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
            `In a v1 route, use inTenant / asUser / asSuperuser from ` +
            `src/app/api/v1/_lib/bind.ts. Elsewhere — a page, a layout, any other ` +
            `route — call runInTenantContext / runAsSuperuser directly; the bind.ts ` +
            `helpers take a RequestContext those do not have. If this file ` +
            `genuinely touches no table, add it to EXEMPT with the reason.`,
        );
      }
    },
  );

  it.each(SCANNED.filter((f) => !EXEMPT_FILES.has(f)))(
    '%s names the RLS context it wants',
    (file) => {
      const src = readFileSync(file, 'utf8');

      // A file that touches no database at all is fine — health, metrics, and
      // most pages. One that does must say which context, rather than
      // inheriting whatever the connection happens to be.
      const code = codeOnly(src);
      const touchesDb = /\b(db|prisma|tx)\b/.test(code) && /@\/app-layer|@\/lib\/db/.test(code);
      if (!touchesDb) return;

      expect(BINDINGS.test(code)).toBe(true);
    },
  );
});
