import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * THE LEDGER IS APPEND-ONLY.
 *
 * A balance you can UPDATE is not a ledger. It is a mutable number with extra
 * steps, and its whole value — that a balance can be RECONSTRUCTED and
 * DISPUTED — is gone. "You say I have €12, prove it" must be answerable by
 * replaying the entries.
 *
 * The database enforces this with a trigger that raises on UPDATE and DELETE.
 * This ratchet enforces two things the trigger cannot:
 *
 *   1. The trigger still EXISTS in the migration history. Deleting a migration,
 *      or a `migrate diff` that does not know the trigger is there, would
 *      silently remove it — and nothing would fail, because application code
 *      never tries to update the ledger anyway. The protection would simply be
 *      gone, and we would find out the first time a bug rewrote history.
 *
 *   2. No application code CALLS update/delete on the ledger. Such a call would
 *      throw at runtime thanks to the trigger — but it would throw in
 *      PRODUCTION, in the middle of a payment, having already aborted the
 *      surrounding transaction. Far better that it never merges.
 */

/** The one file that may change ledger rows: anonymising old zero balances (P93). */
const RETENTION_SWEEP = 'src/app-layer/usecases/retention-sweep.ts';

describe('the credit ledger is append-only', () => {
  const migrations = globSync('prisma/migrations/**/migration.sql').map((f) => f.toString());
  const sourceFiles = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

  it('the scans found their files', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('the append-only trigger exists in the migration history', () => {
    const all = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(all).toMatch(/CREATE TRIGGER\s+"?ledger_append_only_trg/i);
    expect(all).toMatch(/CREATE OR REPLACE FUNCTION\s+ledger_append_only/i);

    // It must fire on BOTH. A trigger that only guards UPDATE lets a DELETE
    // erase the entry entirely — which is strictly worse: an altered row is at
    // least still a row.
    const trigger = all.match(/CREATE TRIGGER\s+ledger_append_only_trg[\s\S]{0,200}/i)?.[0] ?? '';
    expect(trigger).toMatch(/BEFORE\s+UPDATE\s+OR\s+DELETE/i);
  });

  it('no application code updates or deletes a ledger entry', () => {
    // Every Prisma mutation that is not a create, on the ledger model.
    const forbidden = /creditLedgerEntry\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;

    const violations: string[] = [];

    for (const file of sourceFiles) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `The credit ledger is APPEND-ONLY, but ${violations.length} call site(s) mutate it:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nThe database trigger will reject these at runtime — in production, mid-payment,\n` +
          `aborting the surrounding transaction.\n\n` +
          `To correct a balance, INSERT a compensating entry (reason=ADMIN_ADJUST). That is\n` +
          `what a ledger is for: the correction is itself part of the record.`,
      );
    }
  });

  it('raw SQL does not mutate the ledger either', () => {
    // Prisma is not the only way to reach the table. `$executeRaw` is.
    const forbidden = /(?:UPDATE|DELETE\s+FROM)\s+"?credit_ledger_entry"?/i;
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        // The one statement P93's trigger admits: the retention sweep's
        // anonymising UPDATE (owner 2026-11-27), checked below. A DELETE stays
        // forbidden there too.
        if (file === RETENTION_SWEEP && /UPDATE\s+credit_ledger_entry\s+e\b/i.test(line)) return;
        if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it('the retention sweep only takes the person out, and only from a whole zero balance', () => {
    const src = readFileSync(RETENTION_SWEEP, 'utf8');
    const stmt = src.slice(src.indexOf('UPDATE credit_ledger_entry e'));
    const set = stmt.slice(0, stmt.indexOf('FROM g'));
    // Exactly the three columns the trigger lets change, to exactly these values.
    expect(set).toMatch(/SET "userId" = 'anonymised', "refType" = NULL, "refId" = NULL\s*$/);
    expect(src).toMatch(/HAVING SUM\("deltaCents"\) = 0/);
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the patterns actually fire on the code they forbid', () => {
    const prisma = /creditLedgerEntry\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;
    const raw = /(?:UPDATE|DELETE\s+FROM)\s+"?credit_ledger_entry"?/i;

    expect(prisma.test('await db.creditLedgerEntry.update({ where: { id } });')).toBe(true);
    expect(prisma.test('await tx.creditLedgerEntry.deleteMany({});')).toBe(true);
    expect(raw.test('await db.$executeRaw`UPDATE credit_ledger_entry SET x = 1`;')).toBe(true);

    // …and do not fire on the one mutation that IS allowed.
    expect(prisma.test('await db.creditLedgerEntry.create({ data });')).toBe(false);
    expect(prisma.test('await db.creditLedgerEntry.findFirst({ where });')).toBe(false);
  });
});
