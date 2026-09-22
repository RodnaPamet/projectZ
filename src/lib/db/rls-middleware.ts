import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from './prisma';
import { getTenantContext, runWithTenantContext } from './tenant-context';

/**
 * Bind a transaction to a tenant so Postgres RLS applies.
 *
 * Everything on the request path goes through here. A repository that
 * queries outside this wrapper runs as a role with no `app.tenant_id` set,
 * and the fail-closed policy returns zero rows — the caller sees an empty
 * list rather than a loud error, which is exactly the kind of bug that
 * reaches production.
 */

/**
 * Prisma ids are cuid: `c` + base36. Validated BEFORE the value reaches
 * the database.
 *
 * The parameterised `set_config($1)` below already makes injection
 * impossible, so this is defence in depth, not the primary control. What
 * it actually buys is a loud, early failure: a caller passing a slug, an
 * email, or `'; DROP TABLE --` gets an exception naming the problem,
 * instead of a session bound to a nonsense tenant that silently matches no
 * rows.
 */
const CUID_RE = /^c[a-z0-9]{20,32}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(
      `Refusing to bind a tenant context to a malformed tenant id: ${JSON.stringify(value)}. ` +
        `Expected a cuid.`,
    );
    this.name = 'InvalidTenantIdError';
  }
}

export class InvalidUserIdError extends Error {
  constructor(value: string) {
    super(
      `Refusing to bind a user context to a malformed user id: ${JSON.stringify(value)}. ` +
        `Expected a cuid.`,
    );
    this.name = 'InvalidUserIdError';
  }
}

export class NestedTenantContextError extends Error {
  constructor(outer: string, inner: string) {
    super(
      `Nested runInTenantContext: already bound to ${outer}, refused to re-bind to ${inner}. ` +
        `Nesting silently narrows or widens the tenant scope halfway through a request — ` +
        `if you genuinely need cross-tenant access, use the app_superuser path explicitly.`,
    );
    this.name = 'NestedTenantContextError';
  }
}

/**
 * Run `fn` inside a transaction with `app.tenant_id` set and the RLS-bound
 * `app_user` role assumed.
 *
 * `SET LOCAL` / `set_config(..., true)` are transaction-scoped: both are
 * released automatically when the transaction commits OR rolls back. There
 * is deliberately no RESET in a finally block — a leaked binding is
 * impossible by construction, and an explicit RESET would be dead code
 * that implies otherwise.
 */
export async function runInTenantContext<T>(
  tenantId: string,
  fn: (tx: PrismaClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
  opts: { isolationLevel?: Prisma.TransactionIsolationLevel } = {},
): Promise<T> {
  if (!CUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  const existing = getTenantContext();
  if (existing && existing.tenantId !== tenantId) {
    throw new NestedTenantContextError(existing.tenantId, tenantId);
  }

  return runWithTenantContext(tenantId, () =>
    client.$transaction(
      async (tx) => {
        // Parameterised — the tenant id is never string-concatenated into SQL.
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
      },
      // ═══ THE ONLY PLACE ISOLATION CAN BE SET ═══
      //
      // This is the OUTERMOST transaction on every tenant-scoped path, so it
      // is the only `BEGIN` that will ever be issued for that work — and
      // `SET TRANSACTION ISOLATION LEVEL` is legal only there.
      //
      // A use case that asks for SERIALIZABLE on the handle it is given does
      // NOT get it. Prisma sees an interactive transaction already open,
      // treats the inner `$transaction` as nested, issues `SAVEPOINT` instead
      // of `BEGIN`, and DISCARDS the isolation level without a word. Measured:
      // a use case requesting Serializable through this wrapper actually ran
      // at `read committed`, and a ledger built on that assumption wrote ten
      // rows summing to 1000 while its own stored balance said 300.
      //
      // So anything needing more than READ COMMITTED must say so HERE, and
      // the use case must verify it got what it asked for rather than trust
      // the request (see assertSerializable in usecases/wallet.ts).
      opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
    ),
  );
}

/**
 * Bind a transaction to a tenant AND to the acting USER.
 *
 * `app.user_id` exists for one reason: STRAVA.
 *
 * Strava's API Agreement permits their data to be shown to the athlete it
 * belongs to and to NOBODY ELSE — not another player, not a coach, not an
 * aggregate. Tenant scoping cannot express that: everyone at a club shares a
 * tenant. The boundary is per-ATHLETE, so the session has to carry who is
 * asking.
 *
 * The RLS policy on `activity` makes a STRAVA row invisible to anyone but its
 * owner. A buggy query that pulls activities into a leaderboard therefore
 * returns ZERO ROWS rather than someone else's ride — the feature looks broken
 * instead of quietly breaching a contract that would cost every connected
 * athlete their integration.
 *
 * Use this for any request that may touch wearable data. See
 * src/lib/wearables/strava-tos.ts.
 */
export async function runInUserContext<T>(
  ctx: { tenantId: string; userId: string },
  fn: (tx: PrismaClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  if (!CUID_RE.test(ctx.tenantId)) throw new InvalidTenantIdError(ctx.tenantId);
  if (!CUID_RE.test(ctx.userId)) throw new InvalidTenantIdError(ctx.userId);

  return runWithTenantContext(ctx.tenantId, () =>
    client.$transaction(async (tx) => {
      // Both parameterised. Neither id is ever concatenated into SQL.
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, ctx.tenantId);
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, ctx.userId);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return fn(tx as unknown as PrismaClient);
    }),
  );
}

/**
 * Bind a transaction to a USER and to no tenant at all.
 *
 * ─── Why this has to exist ───────────────────────────────────────────
 *
 * Three tables are owner-scoped with NO tenant clause whatsoever:
 *
 *   notification        USING ("userId" = current_setting('app.user_id', true))
 *   push_subscription   USING ("userId" = current_setting('app.user_id', true))
 *   wearable_connection USING ("userId" = current_setting('app.user_id', true))
 *
 * They are person-scoped by design: your notifications are yours at every
 * club you belong to, not yours-at-this-club. A player with memberships at
 * three venues has ONE notification list.
 *
 * `runInUserContext` cannot serve them. It hard-requires a cuid tenantId
 * and throws `InvalidTenantIdError` otherwise — so on a request that has no
 * tenant (a mobile client opening its notification list, which belongs to
 * no club) it does not return zero rows, it throws before reaching the
 * database.
 *
 * ─── The hazard, stated plainly ──────────────────────────────────────
 *
 * This sets `app.user_id` and NOT `app.tenant_id`. Every tenant-scoped
 * policy therefore fails closed, and a tenant-scoped query run in here
 * returns ZERO ROWS WITH NO ERROR — an empty list that looks like "you have
 * no bookings" rather than a bug.
 *
 * So it deliberately does NOT enter `runWithTenantContext`: there is no
 * tenant to enter with, and pretending otherwise would let
 * `getTenantIdOrThrow` hand out a tenant this transaction is not bound to.
 * Code inside here that needs a tenant gets a loud throw from that function,
 * which is the correct outcome.
 *
 * Use it ONLY for the owner-scoped tables above. Anything tenant-scoped
 * belongs in `runInTenantContext`.
 */
export async function runAsUserOnly<T>(
  userId: string,
  fn: (tx: PrismaClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  if (!CUID_RE.test(userId)) throw new InvalidUserIdError(userId);

  return client.$transaction(async (tx) => {
    // Parameterised — the id is never concatenated into SQL.
    await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, userId);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
    return fn(tx as unknown as PrismaClient);
  });
}

/**
 * BYPASSRLS. Migrations, background jobs, cross-tenant admin.
 *
 * Deliberately verbose to call. Every use site should be obvious in review
 * — this is the one path that can read across tenant boundaries.
 *
 * NOTE: this bypasses the Strava owner-only policy too. It is for the IMPORTER
 * (which writes rows on an athlete's behalf) and for deletion. It must never be
 * used to READ Strava data for display.
 */
export async function runAsSuperuser<T>(
  fn: (tx: PrismaClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return fn(tx as unknown as PrismaClient);
  });
}
