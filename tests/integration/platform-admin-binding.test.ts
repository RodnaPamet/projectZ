import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';

import {
  AmbientPlatformEscalationError,
  PlatformReasonRequiredError,
  PlatformWriteNotEnabledError,
  runAsPlatformAdmin,
} from '@/lib/db/platform-admin-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE AUDIT WRITE IS STRUCTURALLY UNAVOIDABLE, AND THIS IS WHERE THAT IS PROVED.
 *
 * `runAsPlatformAdmin` writes the audit row BEFORE the callback, in the same
 * transaction, and the database refuses any audit insert that is not attributed
 * to the admin bound on that transaction. Together those two facts mean a
 * platform action cannot happen without a record — not by convention, and not
 * because a caller remembered.
 *
 * The test that matters most is the rollback one: if the work fails, the audit
 * row must go with it, or the log accumulates rows asserting things that never
 * happened. A log that over-reports is worse than no log, because it is believed.
 */

const REASON = 'support ticket 4821 escalation';

describe('runAsPlatformAdmin', () => {
  const db = prismaTestClient();
  let admin: string;
  let grantId: string;

  beforeEach(async () => {
    await resetDatabase(db);
    admin = `cadmin${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    const granter = `cgrant${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    grantId = `cgr${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app_user (id, email, "createdAt", "updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
        admin,
        `${admin}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
         VALUES ($1,$2,$3,'incident response rota',ARRAY['TENANT_READ']::"PlatformCapability"[], now() + interval '7 days')`,
        grantId,
        admin,
        granter,
      );
    });
  });

  const auditRows = () =>
    asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<{ id: string; action: string; reason: string; actorUserId: string }[]>(
        `SELECT id, action, reason, "actorUserId" FROM platform_audit_entry ORDER BY "createdAt"`,
      ),
    );

  const act = (over: Partial<Parameters<typeof runAsPlatformAdmin>[0]> = {}) => ({
    actorUserId: admin,
    grantId,
    capability: PlatformCapability.TENANT_READ,
    action: 'TENANT_READ',
    reason: REASON,
    ...over,
  });

  it('writes exactly one audit row and runs the work', async () => {
    const result = await runAsPlatformAdmin(act(), async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM venue_org`);
      return Number(rows[0]!.n);
    });

    expect(result).toBe(0);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'TENANT_READ', reason: REASON, actorUserId: admin });
  });

  it('reads ACROSS clubs — the thing it exists for', async () => {
    // Two clubs, and a platform read that sees both. Under any tenant binding
    // this returns one; here it must return two, which is the whole capability.
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO venue_org (id, slug, name, city, country, "contactEmail", timezone, currency, "createdAt", "updatedAt")
         VALUES ('cvo1','a','A','Sofia','BG','a@x.test','Europe/Sofia','EUR',now(),now()),
                ('cvo2','b','B','Plovdiv','BG','b@x.test','Europe/Sofia','EUR',now(),now())`,
      ),
    );

    const seen = await runAsPlatformAdmin(act(), async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM venue_org`);
      return Number(rows[0]!.n);
    });

    expect(seen).toBe(2);
  });

  it('ROLLS BACK the audit row when the work fails', async () => {
    // The most important test here. Audit-before-work is only correct if the
    // two share a fate: a row describing an action that was rolled back is a
    // log that over-reports, and an over-reporting log is worse than none
    // because somebody will believe it.
    await expect(
      runAsPlatformAdmin(act({ action: 'TENANT_READ_FAILING' }), async () => {
        throw new Error('the work blew up');
      }),
    ).rejects.toThrow(/blew up/);

    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a write capability, so TENANT_SUSPEND cannot ship by accident', async () => {
    // Read-only at launch is enforced here, in front of the database, because
    // there is no second factor to step up to.
    await expect(
      runAsPlatformAdmin(act({ capability: PlatformCapability.TENANT_SUSPEND }), async () => 'x'),
    ).rejects.toThrow(PlatformWriteNotEnabledError);

    // And it left no audit row claiming it was attempted.
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a reason too short to answer anything later', async () => {
    await expect(runAsPlatformAdmin(act({ reason: 'because' }), async () => 'x')).rejects.toThrow(
      PlatformReasonRequiredError,
    );
  });

  it('refuses to run nested inside a tenant transaction', async () => {
    // The escalation shape a copy-paste produces: "just one cross-tenant
    // lookup" added inside an existing tenant handler. The audit row would
    // record a standalone platform action with no hint of the tenant request
    // that caused it.
    await expect(
      runInTenantContext('ctenant00000000000000000', async () =>
        runAsPlatformAdmin(act(), async () => 'x'),
      ),
    ).rejects.toThrow(AmbientPlatformEscalationError);

    expect(await auditRows()).toHaveLength(0);
  });

  it('cannot be tricked into attributing the row to someone else', async () => {
    // The GUC is set from `actorUserId`, so these always agree when going
    // through this function. This asserts the database would refuse them
    // DISAGREEING — the guarantee that survives somebody writing their own
    // insert against the table.
    let error: string | undefined;
    try {
      await asAppSuperuser(db, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
        await tx.$executeRawUnsafe(
          `INSERT INTO platform_audit_entry (id,"actorUserId","grantId",capability,action,reason)
           VALUES ($1,'somebody-else',$2,'TENANT_READ'::"PlatformCapability",'FORGED',$3)`,
          `a${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          grantId,
          REASON,
        );
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    expect(error).toMatch(/attribution mismatch/);
    expect(await auditRows()).toHaveLength(0);
  });
});
