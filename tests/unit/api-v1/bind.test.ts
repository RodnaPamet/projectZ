import type { RequestContext } from '@/app-layer/types';
import { asUser, inTenant, MissingTenantError, MissingUserError } from '@/app/api/v1/_lib/bind';

jest.mock('@/lib/db/rls-middleware', () => ({
  runInTenantContext: jest.fn(async (tenantId, fn, _client, opts) => ({ tenantId, opts })),
  runAsUserOnly: jest.fn(async (userId) => ({ userId })),
  runAsSuperuser: jest.fn(async () => ({ superuser: true })),
}));

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: 'usr_1',
  tenantId: 'tnt_1',
  tenantSlug: 'club',
  role: 'PLAYER',
  permissions: [],
  appPermissions: [],
  requestId: 'req_1',
  locale: 'bg',
  ...over,
});

describe('v1 bindings', () => {
  it('inTenant THROWS rather than binding to no tenant', async () => {
    // Binding to nothing does not raise in Postgres — it returns zero rows, and
    // an empty club looks like a club with no courts rather than a bug. The
    // loud failure here is the entire point.
    await expect(inTenant(ctx({ tenantId: null }), async () => 1)).rejects.toThrow(
      MissingTenantError,
    );
  });

  it('asUser THROWS on an anonymous context', async () => {
    await expect(asUser(ctx({ userId: null }), async () => 1)).rejects.toThrow(MissingUserError);
  });

  it('inTenant forwards the isolation level to the OUTER transaction', async () => {
    // A use case asking for Serializable on the handle it receives gets a
    // SAVEPOINT and silently keeps READ COMMITTED. This is the only layer that
    // can set it where Postgres will honour it.
    const r = (await inTenant(ctx(), async () => 1, {
      isolationLevel: 'Serializable',
    })) as unknown as { opts: { isolationLevel: string } };

    expect(r.opts.isolationLevel).toBe('Serializable');
  });

  it('asUser binds the user and NOT a tenant', async () => {
    const r = (await asUser(ctx(), async () => 1)) as unknown as { userId: string };
    expect(r.userId).toBe('usr_1');
  });
});
