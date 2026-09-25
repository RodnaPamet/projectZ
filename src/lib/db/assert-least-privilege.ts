import { prisma } from '@/lib/db/prisma';
import { logger } from '@/lib/observability/logger';

/**
 * Refuse to serve production traffic on the table owner's connection.
 *
 * ═══ WHAT THIS PREVENTS ═══
 *
 * P24 created `playerz_app` — LOGIN, NOINHERIT, no table privileges of its own,
 * both memberships granted WITH INHERIT FALSE. #172 pointed CI's E2E job at it,
 * so a query that forgets its binding fails instead of silently returning every
 * club's rows.
 *
 * That guarantee holds only where `DATABASE_URL` actually names that role. If a
 * deploy forgets the switch, the app keeps the owner connection —
 * `rolsuper=true, rolbypassrls=true`, measured on the cluster — and tenant
 * isolation quietly reverts to being enforced by a CI text scan rather than by
 * the connection. Nothing says so. The app starts, serves, and looks fine.
 *
 * That is the same inversion the cron routes guard against: no credential
 * configured, therefore no check. And it is not hypothetical here — P24 sat
 * unadopted for seven migrations precisely because nothing complained.
 *
 * ═══ WHY IT THROWS RATHER THAN WARNS ═══
 *
 * A refused boot is visible within seconds of a deploy and fixed with one
 * environment change. A warning in a log is how this class of problem survives
 * for months, which is the documented history of the very role it checks for.
 *
 * It is also cheap to get wrong in the safe direction: this can only ever refuse
 * a configuration that holds MORE privilege than intended. It cannot lock anyone
 * out of a correctly-configured deployment.
 *
 * ═══ WHY DEVELOPMENT AND TEST ARE EXEMPT ═══
 *
 * `.env.example` states it plainly: local dev deliberately uses the owner for
 * both URLs so seeding and `psql` stay convenient, and accepts that RLS is
 * therefore not enforced locally. Enforcing this outside production would break
 * every developer's stack and the test harness, which TRUNCATEs and so genuinely
 * needs owner rights.
 */

export class OwnerConnectionInProductionError extends Error {
  constructor(role: string, superuser: boolean, bypassRls: boolean) {
    super(
      `Refusing to start: DATABASE_URL connects as "${role}", which is ` +
        `${superuser ? 'a SUPERUSER' : ''}${superuser && bypassRls ? ' and ' : ''}` +
        `${bypassRls ? 'exempt from row security (BYPASSRLS)' : ''}.\n\n` +
        `Tenant isolation depends on the runtime role NOT being able to bypass RLS. On this\n` +
        `connection a query that forgets its binding returns every club's rows instead of\n` +
        `failing, and nothing raises — the isolation becomes a convention enforced by a CI\n` +
        `text scan rather than by the database.\n\n` +
        `Fix:\n` +
        `  DATABASE_URL         → playerz_app   (runtime; created by migration P24)\n` +
        `  DIRECT_DATABASE_URL  → the owner     (migrations and seeding, which must own tables)\n\n` +
        `playerz_app ships with LOGIN and no password, so it needs one set out of band —\n` +
        `never in a migration, because migrations are git. See docs/platform-admin-runbook.md\n` +
        `and .env.example.`,
    );
    this.name = 'OwnerConnectionInProductionError';
  }
}

interface RoleShape {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

/** What the runtime connection actually is, as Postgres sees it. */
export async function currentRoleShape(): Promise<RoleShape | null> {
  const rows = await prisma.$queryRawUnsafe<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);

  const row = rows[0];
  if (!row) return null;
  return { role: row.rolname, superuser: row.rolsuper, bypassRls: row.rolbypassrls };
}

/**
 * Throws in production if the runtime connection can bypass row security.
 *
 * Takes `env` explicitly rather than reading NODE_ENV directly, so the
 * production branch is testable without setting a global that other tests in
 * the same worker would see.
 */
export async function assertLeastPrivilegeConnection(
  env: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  if (env !== 'production') return;

  let shape: RoleShape | null;
  try {
    shape = await currentRoleShape();
  } catch (err) {
    // A database that cannot be reached at boot is a different failure, and one
    // the readiness probe already reports. Refusing to start over it would turn
    // a transient outage into a deploy that will not roll forward — so this
    // logs and yields rather than throwing.
    logger.error('could not verify the runtime database role at startup', {
      component: 'startup',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!shape) {
    logger.error('pg_roles returned no row for current_user; cannot verify privilege', {
      component: 'startup',
    });
    return;
  }

  if (shape.superuser || shape.bypassRls) {
    throw new OwnerConnectionInProductionError(shape.role, shape.superuser, shape.bypassRls);
  }

  logger.info('runtime database role verified as least-privileged', {
    component: 'startup',
    role: shape.role,
  });
}
