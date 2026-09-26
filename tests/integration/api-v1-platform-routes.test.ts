import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { GET as auditRoute } from '@/app/api/v1/platform/audit/route';
import { GET as tenantsRoute } from '@/app/api/v1/platform/tenants/route';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';
import { logger } from '@/lib/observability/logger';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE PLATFORM ROUTES, ACTUALLY RUN.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL ═══
 *
 * Everything under the platform tree shipped before any route did: the grant
 * table, three triggers, the binding, the CLI, the expiry job. Each was tested.
 * None was reachable. That is this repo's recurring failure — `appPermissions`
 * hardcoded to `[]`, `PLATFORM_ADMIN_API_KEY` with no reader, `execute.ts`
 * documenting "the only two ways" with zero callers — and it is not caught by
 * unit tests, because a unit test of an unreachable thing passes.
 *
 * So these drive the real handlers, through the real token pipeline, against a
 * real Postgres with the real triggers.
 *
 * ═══ THE FOUR THINGS THAT MATTER ═══
 *
 *   it reaches every club            the point of platform authority
 *   it cannot run unaudited          the row is written before the work
 *   a refusal says nothing            403 for authority, 400 for a bad reason,
 *                                     and neither names what is missing
 *   the cursor is correct             or an audit log silently ends at row 50
 *
 * The last one is not hygiene. Prisma's `cursor` resolves against the ORDER BY,
 * and `createdAt` is not unique — the audit row a request writes shares a
 * timestamp with anything else committing in the same tick. Without the
 * tiebreak on `id` the walk SKIPS rows: measured on this database, one per page
 * boundary after the first, never a duplicate and never a loop. The visible
 * symptom is an audit log that is quietly incomplete, which is why it is
 * measured here rather than reasoned about.
 */

describe('the platform routes', () => {
  const db = prismaTestClient();

  let admin: string;
  let granter: string;
  let outsider: string;
  let clubA: string;
  let clubB: string;

  beforeEach(async () => {
    await resetDatabase(db);

    // Two clubs with different owners. A tenant-bound request can only ever see
    // one of them, so "both came back" is what proves the binding crossed.
    const a = await seedTenant({ name: 'Club Alpha' }, db);
    const b = await seedTenant({ name: 'Club Beta' }, db);
    clubA = a.tenantId;
    clubB = b.tenantId;

    // The platform admin is a THIRD person, belonging to neither club. If they
    // were a member of one, "saw club A" would prove nothing.
    admin = `cadm${randomUUID().replace(/-/g, '').slice(0, 21)}`;
    granter = `cgrn${randomUUID().replace(/-/g, '').slice(0, 21)}`;
    // A fourth person who holds a grant the admin does not. Not the granter:
    // `platform_admin_grant_no_self_grant` refuses a grant to oneself, which is
    // what makes the first one two-party — so a self-grant fixture fails on the
    // CHECK before it can test anything about the route.
    outsider = `cout${randomUUID().replace(/-/g, '').slice(0, 21)}`;
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now()), ($5,$6,now(),now())`,
        admin,
        `${admin}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
        outsider,
        `${outsider}@test.invalid`,
      ),
    );
  });

  /** A live grant carrying exactly `caps`. */
  async function grant(
    caps: PlatformCapability[],
    opts: { days?: number; revoked?: boolean; userId?: string } = {},
  ) {
    const id = `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const days = opts.days ?? 30;

    await asAppSuperuser(db, async (tx) => {
      // grantedAt is anchored to expiry rather than to now, so BOTH halves of
      // `CHECK (expiresAt > grantedAt AND expiresAt <= grantedAt + 90 days)`
      // hold for a negative `days` as well as a positive one.
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"grantedAt","expiresAt")
         VALUES ($1,$2,$3,'incident response rota',$4::"PlatformCapability"[],
                 now() + ($5 || ' days')::interval - interval '30 days',
                 now() + ($5 || ' days')::interval)`,
        id,
        opts.userId ?? admin,
        granter,
        `{${caps.join(',')}}`,
        String(days),
      );
      if (opts.revoked) {
        await tx.$executeRawUnsafe(
          `UPDATE platform_admin_grant SET "revokedAt"=now(), "revokedByUserId"=$2,
             "revokeReason"='revoked for the test' WHERE id=$1`,
          id,
          granter,
        );
      }
    });
    return id;
  }

  /** A Bearer token the way /auth/token mints one. */
  async function bearerFor(userId: string) {
    const { userSessionId, sessionVersion } = await createUserSession({
      userId,
      sessionSecret: newSessionSecret(),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return encode({
      secret: process.env.NEXTAUTH_SECRET!,
      maxAge: 900,
      token: { sub: userId, userSessionId, sessionVersion },
    });
  }

  type Route = (req: NextRequest, ctx: unknown) => Promise<Response>;

  const call = (route: Route, path: string, bearer?: string, query = '') =>
    route(
      new NextRequest(`http://t/api/v1/platform/${path}${query}`, {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      }),
      undefined,
    );

  /**
   * A stated reason, on every call that does not supply its own.
   *
   * `?reason=` is REQUIRED — there is deliberately no server-side default,
   * because a reason the server invented reads like a statement by the person
   * who looked and is not one. So the helper supplies one the way a caller
   * would, and the tests that care about its absence pass their own query.
   */
  const REASON = 'verifying the platform surface';

  const withReason = (query: string) =>
    /(\?|&)reason=/.test(query)
      ? query
      : `${query ? `${query}&` : '?'}reason=${encodeURIComponent(REASON)}`;

  const tenants = (bearer?: string, query = '') =>
    call(tenantsRoute as Route, 'tenants', bearer, withReason(query));
  const audit = (bearer?: string, query = '') =>
    call(auditRoute as Route, 'audit', bearer, withReason(query));

  /** Bypasses `withReason`, for the cases that are about the reason itself. */
  const tenantsRaw = (bearer?: string, query = '') =>
    call(tenantsRoute as Route, 'tenants', bearer, query);

  interface PageBody<T> {
    data: { items: T[]; nextCursor: string | null };
  }
  interface ErrBody {
    error: { code: string; message: string };
  }

  const auditRows = () =>
    asAppSuperuser(db, (tx) =>
      tx.platformAuditEntry.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          actorUserId: true,
          action: true,
          capability: true,
          reason: true,
          subjectTenantId: true,
          requestId: true,
        },
      }),
    );

  // ── What the routes are for ──────────────────────────────────────────
  describe('GET /platform/tenants', () => {
    it('THE POINT: a live grant reaches every club, including ones the caller has no membership in', async () => {
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenants(await bearerFor(admin));
      expect(res.status).toBe(200);

      const { data } = (await res.json()) as PageBody<{ id: string; slug: string }>;
      const ids = data.items.map((t) => t.id);

      expect(ids).toContain(clubA);
      expect(ids).toContain(clubB);
      // The admin belongs to neither. Under any tenant binding this is zero
      // rows; under `asUser` it is zero rows. Only the platform binding
      // returns both.
      expect(data.items.length).toBe(2);
    });

    it('records WHO looked, under which capability, and why — before returning anything', async () => {
      await grant([PlatformCapability.TENANT_READ]);
      await tenants(await bearerFor(admin), '?reason=investigating%20a%20duplicate%20club');

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: admin,
        action: 'PLATFORM_TENANT_LIST',
        capability: 'TENANT_READ',
        reason: 'investigating a duplicate club',
        // Null on purpose: a list of every club is about no single one.
        subjectTenantId: null,
      });
      // Correlates the row with every log line for the same request.
      expect(rows[0]!.requestId).toBeTruthy();
    });

    it('returns no club data at all when the capability is missing', async () => {
      // AUDIT_READ is a live grant — just not this one's capability. The
      // interesting case is not the status code but whether anything leaked
      // before the check.
      await grant([PlatformCapability.AUDIT_READ]);

      const res = await tenants(await bearerFor(admin));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain(clubA);
    });
  });

  describe('GET /platform/audit', () => {
    it('reading the audit log is itself audited', async () => {
      // An audit reader that exempted itself could not answer "who has been
      // looking at who looked at what", which is the question an investigation
      // asks first.
      await grant([PlatformCapability.AUDIT_READ]);

      const res = await audit(await bearerFor(admin), '?reason=quarterly%20access%20review');
      expect(res.status).toBe(200);

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'PLATFORM_AUDIT_READ',
        capability: 'AUDIT_READ',
        reason: 'quarterly access review',
      });
    });

    it('shows the row its own read wrote — audit-before-work, observable', async () => {
      // `runAsPlatformAdmin` INSERTs in the same transaction, before `fn`. If
      // the row were written afterwards this read would come back empty on a
      // clean database, which is exactly the window an attacker would want.
      await grant([PlatformCapability.AUDIT_READ]);

      const res = await audit(await bearerFor(admin));
      const { data } = (await res.json()) as PageBody<{ action: string }>;

      expect(data.items.map((e) => e.action)).toEqual(['PLATFORM_AUDIT_READ']);
    });

    it('needs AUDIT_READ specifically — TENANT_READ is a different question', async () => {
      await grant([PlatformCapability.TENANT_READ]);
      expect((await audit(await bearerFor(admin))).status).toBe(403);
    });
  });

  // ── Every way in is closed ───────────────────────────────────────────
  describe('refusals', () => {
    it('401s with no token, and writes nothing', async () => {
      expect((await tenants()).status).toBe(401);
      expect((await audit()).status).toBe(401);
      expect(await auditRows()).toHaveLength(0);
    });

    it.each([
      ['no grant at all', async () => undefined],
      ['an expired grant', async () => grant([PlatformCapability.TENANT_READ], { days: -1 })],
      ['a revoked grant', async () => grant([PlatformCapability.TENANT_READ], { revoked: true })],
      [
        "somebody else's grant",
        async () => grant([PlatformCapability.TENANT_READ], { userId: outsider }),
      ],
    ])('403s on %s, and writes no audit row', async (_label, setup) => {
      await setup();

      const res = await tenants(await bearerFor(admin));
      expect(res.status).toBe(403);
      expect((await res.json()) as ErrBody).toMatchObject({
        error: { code: 'PLATFORM_AUTHORITY_REQUIRED' },
      });

      // Nothing happened, so nothing is recorded. An audit row for a refused
      // request would be defensible — but it is not what the code does, and a
      // test that asserted otherwise would be describing a different system.
      expect(await auditRows()).toHaveLength(0);
    });

    it('does not tell the caller which capability they lack', async () => {
      // The refusal is an ordinary 403. Enumerating what a grant is missing
      // tells someone probing the surface exactly what to ask for next, and
      // the person who legitimately needs to know reads the log.
      await grant([PlatformCapability.TENANT_READ]);

      const body = (await (await audit(await bearerFor(admin))).json()) as ErrBody;

      expect(body.error.code).toBe('PLATFORM_CAPABILITY_REQUIRED');
      expect(body.error.message).not.toMatch(/AUDIT_READ|TENANT_READ/);
    });

    it.each([
      ['no reason at all', ''],
      ['a reason too short to answer anything', '?reason=oops'],
      ['whitespace dressed up as a reason', '?reason=%20%20%20%20%20%20%20%20%20%20%20%20%20%20'],
    ])('400s on %s, and writes no audit row', async (_label, query) => {
      // ═══ WHY THIS IS A 400 AND NOT A 500 ═══
      //
      // `runAsPlatformAdmin` refuses a short reason with
      // PlatformReasonRequiredError, which is unmapped and therefore a 500.
      // That is right for a route that hardcoded something useless. It is wrong
      // for `?reason=oops`, which is an ordinary bad request — and a 500 on a
      // routine client mistake pages somebody at night.
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenantsRaw(await bearerFor(admin), query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrBody).error.code).toBe('REASON_REQUIRED');

      // Refused before the binding ran, so no club data was read and nothing
      // was recorded. The grant lookup in contextFromRequest already happened;
      // that is a query, not a record, and it is not observable here.
      expect(await auditRows()).toHaveLength(0);
    });

    it('400s on a reason Postgres cannot store, instead of a 500', async () => {
      // `text` rejects U+0000, so this used to pass every check and then throw
      // at the INSERT — an unmapped Prisma error, surfacing as a 500 on an
      // endpoint whose 500s are worth waking somebody for.
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenantsRaw(
        await bearerFor(admin),
        `?reason=${encodeURIComponent('a real reason\u0000')}`,
      );
      expect(res.status).toBe(400);
      expect(await auditRows()).toHaveLength(0);
    });

    it('400s on a reason long enough to be a storage problem', async () => {
      // These are GETs, and defineV1Route cannot rate-limit a GET —
      // `resolveRateLimitScope` returns null for a non-mutating method before it
      // reads the options. `reason` lands in an append-only row nobody can
      // prune, so an unbounded one is a slow way to fill a disk.
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenantsRaw(
        await bearerFor(admin),
        `?reason=${encodeURIComponent('x'.repeat(501))}`,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrBody).error.code).toBe('REASON_TOO_LONG');
      expect(await auditRows()).toHaveLength(0);
    });

    it('accepts a long-but-sane reason, so the cap is not a tripwire', async () => {
      await grant([PlatformCapability.TENANT_READ]);
      const res = await tenantsRaw(
        await bearerFor(admin),
        `?reason=${encodeURIComponent('x'.repeat(500))}`,
      );
      expect(res.status).toBe(200);
    });

    it('checks the reason BEFORE authority, so it cannot be used to probe for a grant', async () => {
      // If the order were reversed, a caller could tell "I have no grant" (403)
      // from "my reason is too short" (400) and learn whether a grant exists
      // for them without ever stating a reason. Both must be 400.
      const noGrant = await tenantsRaw(await bearerFor(admin), '?reason=x');
      expect(noGrant.status).toBe(400);
    });

    it("records the caller's own words, not a paraphrase", async () => {
      await grant([PlatformCapability.TENANT_READ]);
      const stated = 'ticket 4471: duplicate club reported by support';

      await tenantsRaw(await bearerFor(admin), `?reason=${encodeURIComponent(stated)}`);

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe(stated);
    });

    it('LOGS what it would not tell the caller', async () => {
      // ═══ THE PROMISE THE 403 BODY MAKES ═══
      //
      // The spec says of these refusals: "Neither message names what is
      // missing; the operator finds that in the log." That was false. Catching
      // in `defineV1Route` means `withApiErrorHandling` sees a returned
      // Response and takes its SUCCESS path — the only line emitted was
      // `{"status":403,"msg":"request completed"}`, at info, with no code, no
      // message and no actor. Someone probing the platform tree with a stolen
      // session was indistinguishable from ordinary traffic, and a legitimately
      // refused admin could not be told why from any record.
      //
      // So the refusal is logged at WARN — not ERROR, since a refused request
      // is not a server fault and must not page anybody — and this asserts the
      // withheld detail is actually in it.
      await grant([PlatformCapability.AUDIT_READ]);
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      try {
        const res = await tenants(await bearerFor(admin));
        expect(res.status).toBe(403);

        const call = warn.mock.calls.find(
          ([, f]) => (f as { code?: string } | undefined)?.code === 'PLATFORM_CAPABILITY_REQUIRED',
        );
        expect(call).toBeDefined();

        const fields = call![1] as { status?: number; error?: string };
        expect(fields.status).toBe(403);
        // The detail the client is deliberately not given — which is the whole
        // reason the body is allowed to be vague.
        expect(fields.error).toMatch(/TENANT_READ/);
        expect(fields.error).toMatch(/AUDIT_READ/);
      } finally {
        warn.mockRestore();
      }
    });

    it('a revoked grant stops working on the NEXT request, not at token expiry', async () => {
      // The reason `appPermissions` is re-read from the database per request
      // instead of being a token claim. A stale claim was a cross-tenant
      // escalation once already.
      const bearer = await bearerFor(admin);
      const id = await grant([PlatformCapability.TENANT_READ]);

      expect((await tenants(bearer)).status).toBe(200);

      await asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE platform_admin_grant SET "revokedAt"=now(), "revokedByUserId"=$2,
             "revokeReason"='stolen laptop, revoked' WHERE id=$1`,
          id,
          granter,
        ),
      );

      // Same token, same session, no re-issue.
      expect((await tenants(bearer)).status).toBe(403);
    });
  });

  // ── The cursor ───────────────────────────────────────────────────────
  describe('paging', () => {
    /**
     * ═══ WHY THESE FIXTURES ARE BIG, AND MUST STAY BIG ═══
     *
     * Both walks below cross THREE page boundaries. That is not padding, it is
     * the difference between a test that measures the thing and one that does
     * not — measured, on this database, by removing the `id` tiebreak from the
     * route and re-running:
     *
     *   n=101, page=100  →  2 pages, 103 of 103 served   bug INVISIBLE
     *   n=205, page=100  →  3 pages, 206 of 207 served   bug caught
     *   n=250, page=100  →  3 pages, 251 of 252 served   bug caught
     *
     * Without the tiebreak Prisma emits `WHERE createdAt >= (cursor's
     * createdAt)` and orders on `createdAt` alone. Every row in a block sharing
     * one timestamp therefore matches every page's WHERE, and the walk slips by
     * exactly one row per boundary after the first. It does not duplicate and it
     * does not loop — it quietly serves one fewer row than exists, which is the
     * worst available failure for an audit log.
     *
     * A previous version of this file used two pages and passed with the
     * tiebreak deleted. Anyone shrinking these fixtures to make the suite
     * faster would disarm it in exactly the same way.
     */

    /** Rows sharing ONE createdAt — the case the tiebreak exists for. */
    const bulkClubs = (n: number) =>
      asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO venue_org (id, slug, name, "contactEmail", "createdAt", "updatedAt")
           SELECT 'cbulk' || lpad(g::text, 18, '0'),
                  'bulk-club-' || g, 'Bulk Club ' || g,
                  'bulk' || g || '@test.invalid', now(), now()
             FROM generate_series(1, $1) AS g`,
          n,
        ),
      );

    it('serves every club exactly once when they all share one createdAt', async () => {
      // One statement, so all 250 rows get the same transaction `now()`. This is
      // the realistic shape as well as the adversarial one: clubs created by an
      // import, audit rows written in the same tick.
      await bulkClubs(250);
      await grant([PlatformCapability.TENANT_READ]);
      const bearer = await bearerFor(admin);

      const total = await asAppSuperuser(db, (tx) => tx.venueOrg.count());

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const res: Response = await tenants(
          bearer,
          cursor ? `?cursor=${encodeURIComponent(cursor)}` : '',
        );
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as PageBody<{ id: string }>;
        seen.push(...data.items.map((t) => t.id));
        cursor = data.nextCursor;
        pages++;
        // A cursor that stops advancing is an infinite loop in a route somebody
        // will drive from a script.
        expect(pages).toBeLessThan(10);
      } while (cursor !== null);

      // Compared against the table, not against a number written here: a
      // hardcoded expectation has to be edited whenever the fixture changes,
      // and the edit is where the assertion gets weakened.
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      // The measurement above: at two pages this passes with the tiebreak gone.
      expect(pages).toBeGreaterThanOrEqual(3);
    });

    it('serves every audit row exactly once, newest first', async () => {
      await grant([PlatformCapability.AUDIT_READ, PlatformCapability.TENANT_READ]);
      const bearer = await bearerFor(admin);

      // A few real reads first, so the fixture below is not the only writer this
      // test has ever seen exercised.
      for (let i = 0; i < 3; i++) await tenants(bearer);

      // The rest inserted directly — through the SAME attribution trigger, which
      // refuses any row whose actorUserId does not match
      // `app.platform_admin_id` on the transaction. 150 more route calls would
      // take a minute to build a fixture that is identical in every way that
      // matters here.
      const grantId = await asAppSuperuser(db, async (tx) => {
        const g = await tx.platformAdminGrant.findFirstOrThrow({
          where: { userId: admin },
          select: { id: true },
        });
        await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
        await tx.$executeRawUnsafe(
          `INSERT INTO platform_audit_entry
             (id,"actorUserId","grantId",capability,action,reason,"detailsJson","createdAt")
           SELECT 'caud' || lpad(g::text, 21, '0'), $1, $2, 'TENANT_READ',
                  'PLATFORM_TENANT_LIST', 'backfilled fixture row', '{}'::jsonb, now()
             FROM generate_series(1, 150) AS g`,
          admin,
          g.id,
        );
        return g.id;
      });
      expect(grantId).toBeTruthy();

      // Ground truth, snapshotted BEFORE the walk. The walk writes a row per
      // page itself; those sort above the cursor and are a bonus, not a
      // requirement.
      const before = new Set(
        (
          await asAppSuperuser(db, (tx) => tx.platformAuditEntry.findMany({ select: { id: true } }))
        ).map((r) => r.id),
      );
      expect(before.size).toBeGreaterThan(150);

      const seen: string[] = [];
      const order: Array<[string, string]> = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const res: Response = await audit(
          bearer,
          cursor ? `?cursor=${encodeURIComponent(cursor)}` : '',
        );
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as PageBody<{ id: string; createdAt: string }>;
        seen.push(...data.items.map((e) => e.id));
        order.push(...data.items.map((e) => [e.createdAt, e.id] as [string, string]));
        cursor = data.nextCursor;
        pages++;
        expect(pages).toBeLessThan(10);
      } while (cursor !== null);

      expect(pages).toBeGreaterThanOrEqual(3);
      // Never twice…
      expect(new Set(seen).size).toBe(seen.length);
      // …and never missed. This is the assertion the tiebreak exists for: the
      // failure it prevents is a row silently absent, not a row repeated.
      //
      // Rows the walk writes as it goes carry a later `createdAt` and sort above
      // the cursor, so they cannot displace these. That is the whole of the
      // stability claim — it does NOT extend to a transaction that opened before
      // the walk and commits during it, whose `createdAt` is its START time and
      // may already have been passed.
      const missed = [...before].filter((id) => !seen.includes(id));
      expect(missed).toEqual([]);

      // NEWEST FIRST, across page boundaries as well as within a page. Only
      // while the order is descending do rows written during a walk sort above
      // the cursor instead of displacing the pages below it.
      //
      // NON-INCREASING, not strictly decreasing, and that is a limit of the
      // payload rather than of the ordering. Responses carry RFC 3339 with no
      // fractional seconds — the API-wide rule, because Swift's default
      // `.iso8601` strategy rejects the `.000` that `toISOString()` emits — so
      // two rows a few milliseconds apart come back with the SAME string while
      // the database ordered them by the milliseconds this test cannot see.
      // Asserting a strict tuple order on (createdAt, id) would therefore fail
      // on correct output, which is how a flaky test gets deleted.
      for (let i = 1; i < order.length; i++) {
        const [prevAt] = order[i - 1]!;
        const [at] = order[i]!;
        expect(prevAt >= at).toBe(true);
      }

      // And no fractional seconds anywhere, which is the rule that forces the
      // weaker assertion above — asserted rather than assumed.
      for (const [at] of order) expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it.each([
      ['a cursor naming no row', '?cursor=cdoesnotexist000000000000'],
      ['a cursor from a different endpoint', '?cursor=notacuidbutwellformed'],
    ])('400s on %s rather than reporting an empty, complete walk', async (_label, query) => {
      // ═══ THE FAILURE THIS REPLACES ═══
      //
      // Prisma resolves `cursor: { id }` through a subquery, so an id matching
      // nothing yields `WHERE createdAt >= NULL` and ZERO ROWS — measured.
      // Zero rows meant hasMore=false, which meant nextCursor=null, which told
      // the caller the walk was COMPLETE. HTTP 200, empty page, nothing wrong.
      //
      // On an audit log that is the exact failure the cursor exists to prevent,
      // arriving by a different route: a reader who believes they have seen
      // everything and has seen nothing.
      await bulkClubs(3);
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenants(await bearerFor(admin), query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrBody).error.code).toBe('INVALID_CURSOR');
    });

    it('400s on a cursor Postgres would reject outright, instead of a 500', async () => {
      // A NUL byte makes Postgres refuse the statement, and the resulting
      // PrismaClientKnownRequestError is unmapped — so this was a
      // client-triggered 500 on an endpoint whose 500s are worth waking for.
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenants(await bearerFor(admin), '?cursor=a%00b');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrBody).error.code).toBe('INVALID_CURSOR');
    });

    it('an empty cursor parameter means page one, not an error', async () => {
      // `?cursor=` is what a client sends when it interpolates a null. Treating
      // it as malformed would break paging for the honest mistake.
      await grant([PlatformCapability.TENANT_READ]);

      const res = await tenants(await bearerFor(admin), '?cursor=');
      expect(res.status).toBe(200);
      expect(((await res.json()) as PageBody<unknown>).data.items).toHaveLength(2);
    });

    it('nextCursor is null when everything fits on one page', async () => {
      // Otherwise a client loops forever on a two-row database.
      await grant([PlatformCapability.TENANT_READ]);
      const { data } = (await (await tenants(await bearerFor(admin))).json()) as PageBody<unknown>;

      expect(data.items).toHaveLength(2);
      expect(data.nextCursor).toBeNull();
    });
  });
});
