import { prismaTestClient } from '../helpers/db';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The SHAPE of every policy actually installed, read from pg_policies.
 *
 * This cannot live in tests/guardrails. That suite scans migration files
 * concatenated together, and migration history is immutable: the P19
 * `USING (true)` and the four NULL-tenant `WITH CHECK`s are still present in
 * the files that created them, even though P23 drops and replaces them. A text
 * scan cannot distinguish a policy that EXISTS from one that merely once did.
 *
 * Only the database knows what is installed. So this asks it.
 */
describe('installed RLS policy shape', () => {
  const db = prismaTestClient();

  type Row = {
    tablename: string;
    policyname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  };

  async function policies(): Promise<Row[]> {
    return asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<Row[]>(
        `SELECT tablename, policyname, cmd, qual, with_check
           FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
      ),
    );
  }

  it('reads the installed policies (an empty read would pass everything)', async () => {
    expect((await policies()).length).toBeGreaterThan(20);
  });

  // ═══ IS ROW SECURITY ACTUALLY ON? ═══
  //
  // Nothing in this repository asked. `grep -rn 'relrowsecurity' src/ tests/`
  // returned nothing at all.
  //
  // The guardrail's ENABLE + FORCE check scans migration history, which is
  // IMMUTABLE — so a later `ALTER TABLE "audit_entry" DISABLE ROW LEVEL
  // SECURITY` can never turn it red: the original ENABLE is still sitting in
  // the file that created it. And the policy-shape tests above read
  // `pg_policies`, where a table with RLS disabled and its policies dropped
  // produces ZERO ROWS and passes every assertion silently.
  //
  // Measured: a migration doing exactly that passed all 38 guardrail suites
  // and this file. Turning off tenant isolation on a table was a green build.
  //
  // `pg_class` is the only thing that knows, so this asks it.

  const GLOBAL_BY_DESIGN = new Set(['User', 'PlayerProfile']);
  const tenantScoped = parseSchemaModels().filter(
    (m) => m.hasTenantId && !GLOBAL_BY_DESIGN.has(m.name),
  );

  type RelRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean };

  async function tableSecurity(): Promise<RelRow[]> {
    return asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<RelRow[]>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      ),
    );
  }

  it('the schema parse and the catalogue read both found something', async () => {
    // Either one returning nothing makes the two assertions below vacuous —
    // and "no tenant-scoped tables are insecure" is trivially true of an empty
    // list, which is exactly how this class of hole survives.
    expect(tenantScoped.length).toBeGreaterThanOrEqual(20);
    expect((await tableSecurity()).length).toBeGreaterThan(20);
  });

  it('every tenant-scoped table has RLS ENABLED and FORCED in the database', async () => {
    const byName = new Map((await tableSecurity()).map((r) => [r.relname, r]));

    const insecure = tenantScoped
      .map((m) => ({ model: m.name, row: byName.get(m.table) }))
      .filter(({ row }) => !row || !row.relrowsecurity || !row.relforcerowsecurity)
      .map(({ model, row }) =>
        !row
          ? `${model}: no such table`
          : `${model}: enabled=${row.relrowsecurity} forced=${row.relforcerowsecurity}`,
      );

    if (insecure.length > 0) {
      throw new Error(
        `Tenant-scoped tables without row security ACTUALLY in force:\n\n` +
          insecure.map((s) => `  ${s}`).join('\n') +
          `\n\nENABLE without FORCE exempts the table OWNER — and migrations run as\n` +
          `the owner. Neither is visible in the migration text once a later\n` +
          `migration turns it off, which is why this is asked of pg_class and not\n` +
          `of the schema.`,
      );
    }

    expect(insecure).toEqual([]);
  });

  it('every tenant-scoped table has at least one policy INSTALLED', async () => {
    // RLS enabled with no policy denies everything, which is a silent outage
    // rather than a silent breach — but a bare `DROP POLICY` that leaves RLS
    // on is invisible to a migration text scan just the same.
    const withPolicy = new Set((await policies()).map((p) => p.tablename));
    const bare = tenantScoped.filter((m) => !withPolicy.has(m.table)).map((m) => m.name);

    expect(bare).toEqual([]);
  });

  it('NO policy is trivially permissive', async () => {
    // `USING (true)` restricts nothing. app_user IS an app role, so "it cannot
    // be reached except through the app roles" is not a control.
    //
    // match_participant shipped exactly this: every tenant could read the whole
    // who-played-whom graph AND insert forged LOSS rows, which feed OpenSkill.
    // A rating cannot be un-computed by subtraction.
    //
    // superuser_bypass is exempt — it is granted TO app_superuser specifically,
    // and being permissive is its entire purpose.
    const open = (await policies()).filter(
      (p) => p.policyname !== 'superuser_bypass' && (p.qual === 'true' || p.with_check === 'true'),
    );

    expect(open.map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`)).toEqual([]);
  });

  it('NO WITH CHECK accepts a NULL tenant', async () => {
    // USING may admit NULL — platform-level rows are meant to be readable.
    // WITH CHECK must not: it lets any session insert an unowned row and then
    // claim it from another tenant. That is the two-step re-parenting attack
    // the asymmetric user_session policy was written to block.
    // ─── One documented exemption, and why it is not the same thing ───
    //
    // conversation.tenantId is NULLABLE BY DESIGN: "a DM between two players
    // who met at different clubs belongs to no tenant". chat_message and
    // conversation_participant are parent-keyed on it, so their WITH CHECK
    // must admit a NULL-tenant parent or cross-club DMs break entirely —
    // nobody could send a message in one.
    //
    // Their protection is participation, not tenancy, and that check currently
    // lives in the app layer (NotAParticipantError, usecases/messaging.ts:143)
    // rather than in RLS. That is a defence-in-depth gap worth closing with
    // participant-keyed policies; it is NOT the laundering hole this test is
    // about, and tightening it here would break the feature.
    const CONVERSATION_KEYED = new Set(['chat_message', 'conversation_participant']);

    const laundering = (await policies()).filter(
      (p) =>
        !CONVERSATION_KEYED.has(p.tablename) &&
        p.with_check?.includes('tenantId') &&
        /IS NULL/i.test(p.with_check),
    );

    expect(laundering.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
  });

  it('password_reset_token is reachable only by the superuser path', async () => {
    // A reset is used by someone not yet signed in, so there is no app.user_id
    // to key a policy on. app_user holds all four DML verbs on every table, so
    // with no policy any session could read, forge or delete reset records.
    const rows = (await policies()).filter((p) => p.tablename === 'password_reset_token');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.qual === 'false' || p.with_check === 'false')).toBe(true);
  });

  it('activity separates READ from WRITE with per-command policies', async () => {
    // A single FOR ALL policy cannot say "readable by others, writable only by
    // the owner": USING governs SELECT, UPDATE and DELETE, while WITH CHECK
    // governs INSERT and UPDATE. Tightening only WITH CHECK leaves DELETE on
    // the permissive USING clause — measured: another user could delete an
    // athlete's workout history, evidence included.
    const cmds = (await policies())
      .filter((p) => p.tablename === 'activity')
      .map((p) => p.cmd)
      .sort();

    expect(cmds).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
