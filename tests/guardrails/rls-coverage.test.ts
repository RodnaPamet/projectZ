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
 * security in the migration history, and a policy that actually KEYS ON a
 * tenant — or, for the two personal models, on the owner. The exceptions are
 * named here explicitly: allowlists you must consciously edit, not rules you
 * can silently fall outside of.
 *
 * ═══ WHAT THIS FILE CANNOT PROVE ═══
 *
 * It scans migration history, which is IMMUTABLE. A later `DISABLE ROW LEVEL
 * SECURITY` or `DROP POLICY` cannot make it red, because the original
 * statements are still sitting in the files that created them. Whether row
 * security is on RIGHT NOW is a question only the database can answer, and it
 * is asked in tests/integration/rls-policy-shape.test.ts against pg_class.
 *
 * Neither half is sufficient alone. This one catches a new model that never
 * had a policy — before it reaches a database. That one catches a policy that
 * was removed.
 *
 * ═══ superuser_bypass IS NOT A PER-MODEL REQUIREMENT ═══
 *
 * This docblock used to promise one on every tenant-scoped model. It was never
 * checked per model, and 12 of 44 do not have one.
 *
 * That is deliberate rather than a gap to backfill: `app_superuser` is created
 * `NOLOGIN BYPASSRLS` (P03), and BYPASSRLS skips row security unconditionally,
 * regardless of FORCE. The bypass POLICIES are defence-in-depth for a world
 * where that attribute is later revoked — they grant nothing today, and the 12
 * models without one behave identically to the 32 with one. Adding them would
 * be a migration that changes no observable behaviour.
 *
 * The single smoke test below keeps the one thing that does matter: wherever
 * such a policy exists, it is granted TO app_superuser and nobody else.
 */

/**
 * GLOBAL BY DESIGN — not an oversight.
 *
 * A player is one identity with one Glicko-2 rating across every venue.
 * Scoping User/PlayerProfile to a tenant would mean joining a second club
 * requires a second account and forks your rating.
 */
const GLOBAL_BY_DESIGN = new Set(['User', 'PlayerProfile']);

/**
 * OWNER-KEYED BY DESIGN — tenant-scoped rows whose policy keys on
 * `app.user_id` rather than `app.tenant_id`.
 *
 * A notification is personal: it belongs to the PERSON, not to the club whose
 * court it is about (P22). A Strava activity is visible only to the athlete
 * who synced it (P20/P23). Requiring a tenant predicate on these would be the
 * wrong boundary entirely — everyone at a club shares a tenant.
 *
 * Two models, and the test below pins that number.
 */
const OWNER_KEYED_BY_DESIGN = new Set(['Notification', 'Activity']);

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

  /**
   * The text of every statement that creates a policy on `table`.
   *
   * ═══ WHY THE NAME IS NOT THE TEST ═══
   *
   * This was `new RegExp('CREATE POLICY [a-z_]+ ON "' + table + '"')` — any
   * policy, under any name, counted. A new tenant-scoped model shipping with
   *
   *     CREATE POLICY payout_batch_readable ON "payout_batch"
   *       FOR SELECT USING (true);
   *
   * passed: no tenant scoping, no isolation, green build. Measured on a probe
   * model — 98 passed, 0 failed.
   *
   * Nor can the fix be "require a policy NAMED tenant_isolation". The real
   * names are heterogeneous by design: P23 computes `<table>_tenant_isolation`,
   * P15 messaging uses `conv_isolation`, and the two personal models use
   * `notification_owner_only` and `activity_*`. What they have in common is not
   * a name — it is that the policy keys on a setting.
   */
  function policyTextsFor(table: string): string[] {
    const texts: string[] = [];

    // Literal form: to the statement terminator.
    for (const m of sql.matchAll(new RegExp(`CREATE POLICY[^;]*? ON "${table}"[^;]*;`, 'g'))) {
      texts.push(m[0]);
    }

    // DO-block form: the block emits the policy for every table in its
    // ARRAY[...], so the block body IS the statement text for each of them.
    for (const block of sql.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)) {
      const body = block[0];
      if (!body.includes('CREATE POLICY')) continue;

      const tables = new Set<string>();
      for (const arr of body.matchAll(/ARRAY\s*\[([^\]]*)\]/g)) {
        for (const lit of arr[1]!.matchAll(/'([a-z_][a-z_0-9]*)'/g)) tables.add(lit[1]!);
      }
      if (tables.has(table)) texts.push(body);
    }

    return texts;
  }

  it('the policy-text resolver finds the known forms', () => {
    // A resolver returning nothing would make every assertion below vacuous —
    // which is precisely the failure this file exists to stop.
    expect(policyTextsFor('booking').length).toBeGreaterThan(0);
    expect(policyTextsFor('notification').length).toBeGreaterThan(0);
    expect(policyTextsFor('chat_message').length).toBeGreaterThan(0);
  });

  it.each(tenantScoped.map((m) => [m.name, m.table]))(
    '%s has a policy that KEYS ON a tenant (or its owner)',
    (name, table) => {
      const texts = policyTextsFor(table);

      if (texts.length === 0) {
        throw new Error(
          `${name} ("${table}") carries a tenantId and no migration creates a policy ` +
            `on it.\n\nENABLE with no policy denies everything — a silent outage. No ` +
            `ENABLE at all is a silent breach. Add a tenant_isolation policy.`,
        );
      }

      const keyedOn = OWNER_KEYED_BY_DESIGN.has(name) ? 'app.user_id' : 'app.tenant_id';
      const scoped = texts.some((t) => t.includes(`current_setting('${keyedOn}', true)`));

      if (!scoped) {
        throw new Error(
          `${name} ("${table}") has a policy, but none of them keys on ` +
            `${keyedOn}.\n\nA policy is not isolation because it exists. ` +
            `\`USING (true)\` restricts nothing, and app_user IS an app role — ` +
            `so every tenant reads every row, with a green build.\n\n` +
            `If this model is genuinely personal rather than tenant-scoped, add ` +
            `it to OWNER_KEYED_BY_DESIGN with the reason.`,
        );
      }
    },
  );

  it('the owner-keyed allowlist contains ONLY the two personal models', () => {
    // Widening this is how a tenant-scoped table quietly stops being
    // tenant-scoped: an entry here exempts it from the predicate above.
    expect([...OWNER_KEYED_BY_DESIGN].sort()).toEqual(['Activity', 'Notification']);
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
