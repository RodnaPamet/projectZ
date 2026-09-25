import { globSync, readFileSync } from 'node:fs';

/**
 * THE AUDIT LOG IS APPEND-ONLY.
 *
 * `audit_entry` is the only record of who changed what. Unlike the credit
 * ledger there is no compensating-entry story: a balance can be corrected by
 * adding a reversing row, but a wrong audit line cannot be un-said. It stays,
 * and the correction is another row saying so.
 *
 * The database enforces this with a trigger. This ratchet enforces the two
 * things the trigger cannot:
 *
 *   1. That the trigger still EXISTS in the migration history. Deleting a
 *      migration, or a `migrate diff` that does not know a trigger is there,
 *      would silently drop it — and nothing would fail, because application
 *      code never tries to update an audit row anyway. The protection would
 *      simply be gone, discovered the first time something rewrote history.
 *
 *   2. That no application code calls update/delete on the model. Such a call
 *      throws at runtime thanks to the trigger — but it throws in PRODUCTION,
 *      mid-request, having already aborted the surrounding transaction and
 *      therefore rolled back whatever legitimate change it was recording.
 */

describe('the audit log is append-only', () => {
  const migrations = globSync('prisma/migrations/**/migration.sql').map((f) => f.toString());
  const sourceFiles = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

  it('the scans found their files', () => {
    // Without this, a broken glob makes every assertion below pass by
    // examining nothing at all.
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('the append-only trigger exists in the migration history', () => {
    const all = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(all).toMatch(/CREATE OR REPLACE FUNCTION\s+audit_append_only/i);
    expect(all).toMatch(/CREATE TRIGGER\s+"?audit_append_only_trg/i);

    // It must fire on BOTH. A trigger guarding only UPDATE lets a DELETE erase
    // the row entirely, which is strictly worse: an altered row is still a row.
    const trigger = all.match(/CREATE TRIGGER\s+audit_append_only_trg[\s\S]{0,200}/i)?.[0] ?? '';
    expect(trigger).toMatch(/BEFORE\s+UPDATE\s+OR\s+DELETE/i);
  });

  it('the table is tenant-isolated', () => {
    // rls-coverage checks this generically. It is repeated here because the
    // consequence is specific: audit rows leaking across tenants would expose
    // one club's staff changes and cancellations to another.
    const all = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(all).toContain('ALTER TABLE "audit_entry" ENABLE ROW LEVEL SECURITY');
    expect(all).toContain('ALTER TABLE "audit_entry" FORCE ROW LEVEL SECURITY');
    expect(all).toMatch(/CREATE POLICY [a-z_]+ ON "audit_entry"/);
  });

  it('no application code updates or deletes an audit entry', () => {
    const forbidden = /auditEntry\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;

    const violations: string[] = [];

    for (const file of sourceFiles) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//')) return;
        if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${t}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it('raw SQL does not mutate an audit entry either', () => {
    // Prisma is not the only way to reach the table. `$executeRaw` is, and the
    // check above only sees `auditEntry.update` — a hand-written statement
    // walks straight past it. ledger-append-only.test.ts:75-89 has had this
    // scan since it landed; the audit log, which is the record of who changed
    // what, did not.
    const forbidden = /(?:UPDATE|DELETE\s+FROM)\s+"?audit_entry"?/i;
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//')) return;
        if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${t}`);
      });
    }

    expect(violations).toEqual([]);
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the patterns actually fire on the code they forbid', () => {
    // Both scans above pass today by finding nothing. That is indistinguishable
    // from a regex that matches nothing ever — which is what a ratchet looks
    // like the day after someone "simplifies" it.
    const prisma = /auditEntry\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;
    const raw = /(?:UPDATE|DELETE\s+FROM)\s+"?audit_entry"?/i;

    expect(prisma.test('await db.auditEntry.update({ where: { id } });')).toBe(true);
    expect(prisma.test('await tx.auditEntry.deleteMany({});')).toBe(true);
    expect(raw.test('await db.$executeRaw`UPDATE audit_entry SET action = $1`;')).toBe(true);
    expect(raw.test('await db.$executeRawUnsafe(`DELETE FROM "audit_entry"`);')).toBe(true);

    // …and do not fire on the writes that ARE allowed. `create` is the only
    // mutation an append-only log has, and reads must stay legal.
    expect(prisma.test('await db.auditEntry.create({ data });')).toBe(false);
    expect(prisma.test('await db.auditEntry.findFirst({ where });')).toBe(false);
    expect(raw.test('await db.$queryRaw`SELECT * FROM audit_entry`;')).toBe(false);
  });

  it('appendAuditEntry takes a caller-supplied client', () => {
    // The signature IS the guarantee. A helper that reaches for its own client
    // writes on a separate connection, so the audit row can commit while the
    // change it describes rolls back — a log asserting something that never
    // happened, which is worse than no log because it is believed.
    const src = readFileSync('src/lib/audit.ts', 'utf8');

    expect(src).toMatch(/export async function appendAuditEntry\(\s*db: PrismaClient,/);
    // No module-scope client import to fall back on.
    expect(src).not.toMatch(/^import .*\bfrom '@\/lib\/db(\/|')/m);
  });
});
