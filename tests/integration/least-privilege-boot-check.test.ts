import {
  assertLeastPrivilegeConnection,
  currentRoleShape,
  OwnerConnectionInProductionError,
} from '@/lib/db/assert-least-privilege';

/**
 * THE BOOT CHECK, AGAINST A REAL CONNECTION.
 *
 * #172 made CI's E2E job run the app as `playerz_app`, so a query that forgets
 * its binding fails instead of silently returning every club's rows. That
 * guarantee holds only where `DATABASE_URL` actually names that role.
 *
 * A production deploy that forgets the switch keeps the owner connection —
 * `rolsuper=true, rolbypassrls=true` — and tenant isolation reverts to being
 * enforced by a CI text scan. Nothing says so; the app starts and looks fine.
 * P24 sat unadopted for seven migrations precisely because nothing complained.
 *
 * ═══ WHY THIS RUNS AS AN INTEGRATION TEST ═══
 *
 * The check asks Postgres what the current role actually is. Mocking
 * `pg_roles` would test the `if` statement and nothing else — and the thing
 * worth knowing is whether a REAL connection is correctly classified. The test
 * harness connects as the owner, which is exactly the configuration production
 * must refuse, so this suite has the dangerous case available for free.
 */

describe('assertLeastPrivilegeConnection', () => {
  it('sees the test harness connection for what it is: the owner', async () => {
    // The premise every assertion below rests on. If the harness ever stopped
    // connecting as a privileged role, the production test would pass by
    // examining a safe connection and prove nothing.
    const shape = await currentRoleShape();

    expect(shape).not.toBeNull();
    expect(shape!.superuser || shape!.bypassRls).toBe(true);
  });

  it('REFUSES to boot in production on that connection', async () => {
    // The assertion that matters. Everything else here is scaffolding.
    await expect(assertLeastPrivilegeConnection('production')).rejects.toThrow(
      OwnerConnectionInProductionError,
    );
  });

  it('names the fix in the error, not just the problem', async () => {
    // This message is read by somebody whose deploy just refused to start, and
    // "permission denied"-style accuracy without a next step is how a good
    // guard becomes a thing people disable.
    const err = await assertLeastPrivilegeConnection('production').catch((e: unknown) => e);

    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('playerz_app');
    expect(message).toContain('DIRECT_DATABASE_URL');
    // And why it matters, so the reader can judge whether to override it.
    expect(message).toMatch(/every club's rows/);
  });

  it('allows development and test, which deliberately use the owner', async () => {
    // .env.example states this: local dev uses the owner for both URLs so
    // seeding and psql stay convenient, accepting that RLS is not enforced
    // locally. Enforcing here would break every developer's stack and this
    // harness, which TRUNCATEs and genuinely needs owner rights.
    await expect(assertLeastPrivilegeConnection('development')).resolves.toBeUndefined();
    await expect(assertLeastPrivilegeConnection('test')).resolves.toBeUndefined();
    await expect(assertLeastPrivilegeConnection(undefined)).resolves.toBeUndefined();
  });

  it('is wired into the startup path, not merely exported', async () => {
    // A boot check nothing calls is the failure mode this whole repo keeps
    // producing. `register()` in src/instrumentation.ts is what Next invokes
    // once per server instance, before the first request.
    const { readFileSync } = await import('node:fs');

    const entry = readFileSync('src/instrumentation.ts', 'utf8');
    expect(entry).toMatch(/export async function register/);
    // Behind a runtime check AND a dynamic import: a static import would be
    // bundled for the edge runtime regardless of which branch runs, dragging
    // `pg` in with it.
    expect(entry).toMatch(/NEXT_RUNTIME === 'nodejs'/);
    expect(entry).toMatch(/await import\('\.\/instrumentation-node'\)/);

    const node = readFileSync('src/instrumentation-node.ts', 'utf8');
    expect(node).toMatch(/assertLeastPrivilegeConnection\(\)/);
  });
});
