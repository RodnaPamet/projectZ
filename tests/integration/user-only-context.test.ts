import { runAsUserOnly, runInTenantContext, InvalidUserIdError } from '@/lib/db/rls-middleware';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * `runAsUserOnly` against real RLS.
 *
 * The unit tests mock the database, so they prove the wiring and nothing about
 * isolation. These assert what Postgres actually returns, which is the only
 * thing that matters: every policy here fails CLOSED, so a binding that is
 * subtly wrong yields an empty list rather than an error, and an empty list is
 * indistinguishable from "you have no notifications" until a user complains.
 */
describe('runAsUserOnly', () => {
  const db = prismaTestClient();
  let tenant: SeededTenant;

  beforeEach(async () => {
    tenant = await seedTenant({}, db);
    await asAppSuperuser(db, (tx) =>
      tx.notification.create({
        data: {
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          kind: 'BOOKING_CONFIRMED',
          title: 'x',
          body: 'y',
        },
      }),
    );
  });

  it('sees the owner-scoped rows that belong to the user', async () => {
    // notification, push_subscription and wearable_connection are keyed on
    // app.user_id with NO tenant clause — person-scoped by design, because your
    // notifications are yours at every club you belong to.
    expect(await runAsUserOnly(tenant.userId, (tx) => tx.notification.count())).toBe(1);
  });

  it('sees NOTHING belonging to another user', async () => {
    const other = await seedTenant({}, db);
    expect(await runAsUserOnly(other.userId, (tx) => tx.notification.count())).toBe(0);
  });

  it('FAILS CLOSED on tenant-scoped tables — the documented hazard', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `v-${Date.now()}`,
          name: 'V',
          addressLine: '1',
          city: 'Sofia',
          email: `v-${Date.now()}@playerz.test`,
          lat: 42.7,
          lng: 23.3,
        },
      }),
    );

    // No app.tenant_id is set in here, so every tenant policy denies. This is
    // the trade-off of a tenant-free binding, asserted so nobody discovers it
    // as a mystery empty list instead.
    expect(await runAsUserOnly(tenant.userId, (tx) => tx.venue.count())).toBe(0);

    // …and the tenant binding still sees it, so the row really is there.
    expect(await runInTenantContext(tenant.tenantId, (tx) => tx.venue.count())).toBe(1);
  });

  it('the two bindings are COMPLEMENTARY, not interchangeable', async () => {
    // runInTenantContext sets no app.user_id, so it cannot see owner-scoped
    // rows either. Picking the wrong one is silent in both directions.
    expect(await runInTenantContext(tenant.tenantId, (tx) => tx.notification.count())).toBe(0);
  });

  it('refuses a malformed user id rather than binding to nonsense', async () => {
    await expect(runAsUserOnly('not-a-cuid', async () => 1)).rejects.toThrow(InvalidUserIdError);
    await expect(runAsUserOnly("'; DROP TABLE app_user; --", async () => 1)).rejects.toThrow(
      InvalidUserIdError,
    );
  });
});
