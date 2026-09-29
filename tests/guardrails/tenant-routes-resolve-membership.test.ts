import { globSync, readFileSync } from 'node:fs';

import { exportsMethod } from '../helpers/route-exports';
import { codeOnly, entryFor, reachableFrom, topLevelRegions } from '../helpers/route-source';

/**
 * EVERY TENANT ROUTE DECIDES MEMBERSHIP FROM THE DATABASE, BEFORE ANYTHING ELSE.
 *
 * ═══ WHY THIS IS NOW LOAD-BEARING (#250) ═══
 *
 * The edge used to refuse any tenant request whose token did not list the
 * club. That refused the iOS client everywhere — native tokens list no clubs —
 * and refused #229's join-on-booking at the club being joined, so it now lets
 * those requests through UNDECIDED (`needs_db_check`), and skips its own
 * permission check for them because it has no claim to derive one from.
 *
 * That is only safe because something else decides. `contextFromRequest`
 * resolves the membership from the database and enforces the SAME permission
 * table against the role it finds, before the handler does anything. A tenant
 * route that does not go through it would be a route the edge waves through
 * and nothing else checks — a mutation made allowed by a missing claim, which
 * is the one outcome #250 was told must never happen.
 *
 * So, per mounted verb, not per file: a second handler added beside a
 * compliant one is the realistic way to get this wrong.
 *
 *   1. every verb under `/api/{vN/}t/[slug]/` reaches `contextFromRequest`,
 *      passing the slug it is about;
 *   2. the decider reads the database and the permission table, and does not
 *      read the token's claim list;
 *   3. only the join-on-booking POST may admit a non-member, and it must be
 *      the handler that actually creates the membership.
 *
 * ═══ WHAT IT CANNOT SEE ═══
 *
 * Whether the context is built BEFORE the handler reads the body or touches the
 * database. Every route today does it on its first or second line; nothing
 * textual can prove ordering, and saying so beats implying it.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** `/api/t/[slug]/...` and `/api/v1/t/[slug]/...` — the shapes `tenantSlugFromPath` recognises. */
const TENANT_ROUTE = /^src\/app\/api\/(?:v\d+\/)?t\/\[slug\]\//;

const routes = globSync('src/app/api/**/route.ts')
  .map((f) => f.toString())
  .filter((f) => TENANT_ROUTE.test(f))
  .sort();

const mounted: Array<[string, string]> = routes.flatMap((file) => {
  const code = codeOnly(readFileSync(file, 'utf8'));
  return METHODS.filter((m) => exportsMethod(code, m)).map((m) => [file, m] as [string, string]);
});

/** A call that builds the context for THIS club: the options object names `slug`. */
const RESOLVES_WITH_SLUG = /\bcontextFromRequest\s*\(\s*\w+\s*,\s*\{[^}]*\bslug\b/s;

const reach = (file: string, method: string): string => {
  const code = codeOnly(readFileSync(file, 'utf8'));
  return reachableFrom(topLevelRegions(code), entryFor(code, method));
};

/** The one route that may admit a non-member, because it is how one joins. */
const JOIN_ROUTE = 'src/app/api/v1/t/[slug]/bookings/route.ts';

const CONTEXT = 'src/app/api/v1/_lib/context.ts';

describe('tenant routes resolve membership from the database', () => {
  it('found the tenant routes and the verbs they mount', () => {
    // ═══ THE VACUITY GUARD ═══
    //
    // Every check below iterates these lists. A glob that matched nothing — a
    // moved tree, a renamed segment — would pass them all while checking
    // nothing. Nine files and fourteen verbs today.
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(mounted.length).toBeGreaterThanOrEqual(12);
    expect(routes).toContain(JOIN_ROUTE);
  });

  it.each(routes)('%s mounts a verb this suite can see', (file) => {
    // A route exporting its verbs in a form `exportsMethod` cannot parse would
    // contribute nothing to `mounted`, and so would never be checked below.
    const code = codeOnly(readFileSync(file, 'utf8'));
    expect(METHODS.filter((m) => exportsMethod(code, m)).length).toBeGreaterThan(0);
  });

  it.each(mounted)('%s: %s reaches contextFromRequest with the slug', (file, method) => {
    if (!RESOLVES_WITH_SLUG.test(reach(file, method))) {
      throw new Error(
        `${method} ${file} does not build its context with contextFromRequest(req, { slug, … }).\n\n` +
          `Since #250 the edge lets a signed-in caller through to a tenant route whenever\n` +
          `the token does not list the club — a native token lists none — and skips its\n` +
          `permission check, because it has no claim to check. contextFromRequest is what\n` +
          `then decides: it reads the membership from the database and enforces the same\n` +
          `ROUTE_PERMISSIONS rule against the role it finds.\n\n` +
          `A tenant route that skips it is reachable by anybody signed in.`,
      );
    }
  });

  it('the decider reads the database and the permission table — and not the claim list', () => {
    const code = codeOnly(readFileSync(CONTEXT, 'utf8'));

    // The table the edge uses, looked up again where it can be checked.
    expect(code).toMatch(
      /\brequiredPermission\s*\(\s*req\.nextUrl\.pathname\s*,\s*req\.method\s*\)/,
    );
    // The database resolution the pages use.
    expect(code).toMatch(/\bmembershipContext\s*\(/);
    // Not `raw.memberships`, `token.memberships`, or anything like them: the
    // list cannot say who is NOT a member, and can say "OWNER" for a week after
    // a demotion.
    expect(code).not.toMatch(/\.memberships\b/);
  });

  it('only the join-on-booking POST admits a non-member', () => {
    const offenders = globSync(['src/**/*.ts', 'src/**/*.tsx'])
      .map((f) => f.toString())
      .filter((f) => f !== CONTEXT)
      .filter((f) => /\bjoinsAsPlayer\b/.test(codeOnly(readFileSync(f, 'utf8'))));

    expect(offenders).toEqual([JOIN_ROUTE]);

    // Within that file, the POST — not the list. Listing must never join.
    expect(reach(JOIN_ROUTE, 'POST')).toMatch(/\bjoinsAsPlayer\s*:\s*true\b/);
    expect(reach(JOIN_ROUTE, 'GET')).not.toMatch(/\bjoinsAsPlayer\b/);
  });

  it('the route that admits a non-member is the one that creates the membership', () => {
    // A flag that admitted non-members to a handler that did not join them
    // would hand that handler a context with no tenant — refused at `inTenant`,
    // but only by luck of the next line. The flag and the join travel together.
    expect(reach(JOIN_ROUTE, 'POST')).toMatch(
      /\bresolvePlayerTenant\s*\([^)]*\bcreateIfAbsent\s*:\s*true\b/s,
    );
  });
});

describe('the detectors fire', () => {
  const ROUTE = [
    'async function listHandler(req: NextRequest, { params }: Ctx) {',
    '  const { slug } = await params;',
    '  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });',
    '  return page([], null);',
    '}',
    '',
    'async function createHandler(req: NextRequest) {',
    '  return NextResponse.json({ ok: true });',
    '}',
    '',
    'export const GET = defineV1Route(listHandler);',
    'export const POST = defineV1Route(createHandler);',
  ].join('\n');

  const reached = (method: string) =>
    reachableFrom(topLevelRegions(ROUTE), entryFor(ROUTE, method));

  it('credits a verb that builds its context with the slug', () => {
    expect(RESOLVES_WITH_SLUG.test(reached('GET'))).toBe(true);
  });

  it('does NOT credit a second verb with the first one’s context', () => {
    // The file mentions contextFromRequest; the POST never calls it.
    expect(RESOLVES_WITH_SLUG.test(ROUTE)).toBe(true);
    expect(RESOLVES_WITH_SLUG.test(reached('POST'))).toBe(false);
  });

  it('does not credit a context built without the slug', () => {
    // That context is tenant-less by construction: no membership is resolved,
    // and a permission-gated path is refused rather than checked.
    expect(
      RESOLVES_WITH_SLUG.test('const ctx = await contextFromRequest(req, { requestId: id });'),
    ).toBe(false);
  });

  it('reads code, not the prose or strings that mention it', () => {
    expect(
      RESOLVES_WITH_SLUG.test(codeOnly('// contextFromRequest(req, { slug }) runs upstream')),
    ).toBe(false);
    expect(
      RESOLVES_WITH_SLUG.test(codeOnly("const s = 'contextFromRequest(req, { slug })';")),
    ).toBe(false);
  });

  it('sees the join flag only where it is set to true', () => {
    expect(/\bjoinsAsPlayer\s*:\s*true\b/.test('    joinsAsPlayer: true,')).toBe(true);
    expect(/\bjoinsAsPlayer\s*:\s*true\b/.test('    joinsAsPlayer: false,')).toBe(false);
  });
});
