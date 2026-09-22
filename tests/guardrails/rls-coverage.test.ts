import { allMigrationSql, parseSchemaModels } from '../helpers/prisma-schema-models';

/**
 * RLS COVERAGE RATCHET.
 *
 * Tenant isolation is only as strong as its weakest table. Adding a model
 * with a `tenantId` and forgetting its policy produces no error, no failing
 * test, and no visible symptom — just a table any authenticated tenant can
 * read in full. That is a data breach that ships green.
 *
 * So: every model carrying a tenantId MUST have ENABLE + FORCE row level
 * security, a tenant_isolation policy, and a superuser_bypass policy. The
 * only exceptions are the two models that are global BY DESIGN, and they
 * are named here explicitly — an allowlist you must consciously edit, not
 * a rule you can silently fall outside of.
 */

/**
 * GLOBAL BY DESIGN — not an oversight.
 *
 * A player is one identity with one Glicko-2 rating across every venue.
 * Scoping User/PlayerProfile to a tenant would mean joining a second club
 * requires a second account and forks your rating.
 */
const GLOBAL_BY_DESIGN = new Set(['User', 'PlayerProfile']);

describe('RLS coverage', () => {
  const models = parseSchemaModels();
  const sql = allMigrationSql();

  it('parses the schema (a parser returning nothing would pass everything)', () => {
    // Without this, a broken regex silently makes the whole ratchet vacuous.
    expect(models.length).toBeGreaterThanOrEqual(10);
    expect(models.map((m) => m.name)).toEqual(
      expect.arrayContaining(['VenueOrg', 'User', 'PlayerProfile', 'TenantMembership']),
    );
  });

  const tenantScoped = models.filter((m) => m.hasTenantId && !GLOBAL_BY_DESIGN.has(m.name));

  it('finds the tenant-scoped models', () => {
    expect(tenantScoped.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * ═══ WHY THIS IS NOT A SUBSTRING SEARCH ═══
   *
   * This check used to fall back to `new RegExp(`'${table}'`).test(sql)` when
   * the literal ALTER was absent — "either the literal, or the DO-block loop
   * that emits it". That matches ANY single-quoted occurrence of the name
   * anywhere in every migration concatenated together: a mention in a comment,
   * a `pg_roles` lookup, an unrelated array. Worse, `enabled` and `forced` used
   * the IDENTICAL fallback, so FORCE was never independently checked at all.
   *
   * A table could therefore have ENABLE and no FORCE — leaving the OWNER
   * exempt, and migrations run as the owner — and this suite stayed green.
   *
   * So the loops are actually resolved: each DO block is read, the table names
   * in its ARRAY[...] literals are collected, and the block is credited only
   * with what its body genuinely executes.
   */
  function tablesFromDoBlocks(needle: string): Set<string> {
    const out = new Set<string>();

    // Non-greedy to the block terminator, so two adjacent DO blocks are not
    // merged into one and credited with each other's statements.
    for (const block of sql.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)) {
      const body = block[0];
      if (!body.includes(needle)) continue;

      for (const arr of body.matchAll(/ARRAY\s*\[([^\]]*)\]/g)) {
        for (const lit of arr[1]!.matchAll(/'([a-z_][a-z_0-9]*)'/g)) out.add(lit[1]!);
      }
    }
    return out;
  }

  const loopEnabled = tablesFromDoBlocks('ENABLE ROW LEVEL SECURITY');
  const loopForced = tablesFromDoBlocks('FORCE ROW LEVEL SECURITY');
  const loopPolicied = tablesFromDoBlocks('CREATE POLICY');

  it('the DO-block resolver actually found the loops', () => {
    // If the regex broke, every table would fall back to needing a literal
    // ALTER and this suite would fail loudly rather than pass vacuously — but
    // assert it anyway, because a resolver that finds nothing is the exact
    // failure this file exists to stop.
    expect(loopEnabled.size).toBeGreaterThan(5);
    expect(loopForced.size).toBeGreaterThan(5);
  });

  it.each(tenantScoped.map((m) => [m.name, m.table]))(
    '%s has ENABLE + FORCE row level security',
    (_name, table) => {
      const enabled =
        sql.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`) || loopEnabled.has(table);
      const forced =
        sql.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`) || loopForced.has(table);

      expect(enabled).toBe(true);
      expect(forced).toBe(true);
    },
  );

  it.each(tenantScoped.map((m) => [m.name, m.table]))('%s has a POLICY', (_name, table) => {
    // The docblock above has always promised this and never checked it. ENABLE
    // with no policy denies everything, which is safe but breaks the feature;
    // a table with FORCE and no policy is a silent outage rather than a silent
    // breach, and both deserve to fail here.
    const hasPolicy =
      new RegExp(`CREATE POLICY [a-z_]+ ON "${table}"`).test(sql) || loopPolicied.has(table);

    expect(hasPolicy).toBe(true);
  });

  // NOTE: "no policy is trivially permissive" and "no WITH CHECK accepts a NULL
  // tenant" deliberately live in tests/integration/rls-policy-shape.test.ts
  // instead, queried from pg_policies.
  //
  // They cannot be asserted here. This file scans every migration concatenated,
  // and migration history is immutable: the P19 `USING (true)` and the four
  // NULL-tenant WITH CHECKs are still present in the files that created them,
  // even though P23 drops and replaces them. A text scan cannot tell a policy
  // that EXISTS from one that merely once existed — only the database knows
  // which policies are actually installed.

  it('venue_org is policy-protected on its own id', () => {
    expect(sql).toContain('ALTER TABLE "venue_org" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "venue_org" FORCE ROW LEVEL SECURITY');
  });

  it('every policy uses the two-argument current_setting (fail-closed)', () => {
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    // The bare form RAISES on a missing setting instead of returning NULL,
    // turning a clean "0 rows" into a 500.
    expect(sql).not.toMatch(/current_setting\(\s*'app\.tenant_id'\s*\)/);
  });

  it('grants superuser_bypass only TO app_superuser', () => {
    expect(sql).toMatch(/CREATE POLICY superuser_bypass ON[\s\S]{0,60}TO app_superuser/);
  });

  it('User and PlayerProfile have NO tenant policy (global by design)', () => {
    // The inverse assertion matters too: if someone "helpfully" adds RLS to
    // User, a player could not sign in without a tenant already selected.
    expect(sql).not.toMatch(/ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE "player_profile" ENABLE ROW LEVEL SECURITY/);
  });

  it('the allowlist contains ONLY the two global models', () => {
    // Widening this set is how tenant isolation quietly dies. Any addition
    // has to change this test, which forces the conversation.
    expect([...GLOBAL_BY_DESIGN].sort()).toEqual(['PlayerProfile', 'User']);
  });
});
