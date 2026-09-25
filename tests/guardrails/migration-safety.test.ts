import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * MIGRATION SAFETY RATCHET.
 *
 * Every load-bearing guarantee in this product lives in a database object
 * Prisma CANNOT MODEL:
 *
 *   booking_no_overlap   — an EXCLUDE constraint. The ONLY thing that makes
 *                          double-booking impossible under concurrency.
 *   venue.geog           — a PostGIS geography column.
 *   venue_geog_idx       — a GiST index. Without it, "venues near me" is a
 *                          sequential scan.
 *   ledger_append_only   — the trigger that makes the wallet a ledger rather
 *                          than a mutable number.
 *
 * And `prisma migrate diff --from-config-datasource` compares the LIVE
 * DATABASE to the schema, so **anything Prisma cannot model looks like drift
 * to be removed**.
 *
 * This has now happened THREE times:
 *
 *   P13 — proposed `ALTER TABLE booking DROP COLUMN "courtId"`, which would
 *         have taken `booking_no_overlap` with it.
 *   P15 — the migration for CHAT proposed dropping `venue.geog` and
 *         `venue_geog_idx`, silently deleting the GEO feature added one
 *         prompt earlier.
 *   P16 — proposed dropping `venue_geog_idx` again.
 *
 * Each diff looks entirely routine. Relying on a human to read every generated
 * migration is exactly the control that fails on the busy day.
 *
 * So: a migration may not DROP a protected object unless it recreates it in
 * the same file.
 */

interface Protected {
  name: string;
  /** Matches a statement that DESTROYS it. */
  drop: RegExp;
  /** Matches a statement that RECREATES it — a rename or rebuild is fine. */
  recreate: RegExp;
  why: string;
}

const PROTECTED: Protected[] = [
  {
    name: 'booking_no_overlap (EXCLUDE constraint)',
    drop: /(?:DROP\s+CONSTRAINT\s+"?booking_no_overlap|ALTER TABLE\s+"?booking"?\s+DROP COLUMN\s+"?(?:resourceId|startTs|endTs|status)"?)/i,
    recreate: /ADD CONSTRAINT\s+booking_no_overlap|RENAME COLUMN/i,
    why: 'the ONLY defence against double-booking under concurrency',
  },
  {
    name: 'coach_no_overlap (EXCLUDE constraint)',
    drop: /DROP\s+CONSTRAINT\s+"?coach_no_overlap/i,
    recreate: /ADD CONSTRAINT\s+coach_no_overlap/i,
    why: 'a coach cannot be in two places at once',
  },
  {
    name: 'venue.geog (PostGIS column)',
    drop: /ALTER TABLE\s+"?venue"?\s+DROP COLUMN\s+"?geog"?/i,
    recreate: /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?geog/i,
    why: '"venues near me" stops working entirely',
  },
  {
    name: 'venue_geog_idx (GiST index)',
    drop: /DROP INDEX\s+(?:IF EXISTS\s+)?"?venue_geog_idx"?/i,
    recreate: /CREATE INDEX\s+(?:IF NOT EXISTS\s+)?"?venue_geog_idx"?/i,
    why: 'geo search degrades to a sequential scan over every venue',
  },
  {
    name: 'moderation_case_one_open_idx (PARTIAL unique index)',
    drop: /DROP INDEX\s+(?:IF EXISTS\s+)?"?moderation_case_one_open_idx/i,
    recreate: /CREATE UNIQUE INDEX\s+(?:IF NOT EXISTS\s+)?"?moderation_case_one_open_idx/i,
    why: 'a brigade can bury the moderation queue in duplicate reports of one item',
  },
  {
    name: 'review_rating_range (CHECK)',
    drop: /DROP\s+CONSTRAINT\s+"?review_rating_range/i,
    recreate: /ADD CONSTRAINT\s+review_rating_range/i,
    why: 'a 0- or 6-star rating silently skews every average that includes it',
  },
  {
    name: 'rating_engine_shape (CHECK)',
    drop: /DROP\s+CONSTRAINT\s+"?rating_engine_shape/i,
    recreate: /ADD CONSTRAINT\s+rating_engine_shape/i,
    why: 'a Glicko row with no phi is uninterpretable, and an openskill row with one is the wrong shape entirely',
  },
  {
    name: 'xp_event no-update trigger',
    drop: /DROP TRIGGER\s+(?:IF EXISTS\s+)?"?xp_event_no_update/i,
    recreate: /CREATE TRIGGER\s+"?xp_event_no_update/i,
    why: 'an editable XP log cannot answer "why am I level 7?", and a clawback becomes a silent subtraction',
  },
  {
    name: 'ledger append-only trigger',
    drop: /DROP TRIGGER\s+(?:IF EXISTS\s+)?"?ledger_append_only/i,
    recreate: /CREATE TRIGGER\s+"?ledger_append_only/i,
    why: 'a wallet you can UPDATE is not a ledger, it is a mutable number',
  },
  {
    name: 'audit_append_only_trg (append-only trigger)',
    // The ledger trigger above has been protected since it landed; the audit
    // one never was, so `migrate diff` could propose dropping it and every
    // guardrail would still pass. An audit log that can be edited after the
    // fact is worth less than no audit log, because it still looks like
    // evidence.
    //
    // `DROP TRIGGER IF EXISTS` followed by `CREATE TRIGGER` is how P26 installs
    // it, and the recreate pattern is what keeps that idempotent pair legal.
    drop: /DROP TRIGGER\s+(?:IF EXISTS\s+)?"?audit_append_only_trg/i,
    recreate: /CREATE TRIGGER\s+"?audit_append_only_trg/i,
    why: 'an audit log you can UPDATE or DELETE is not evidence, and still looks like it',
  },
  // ── P31, platform administration ──────────────────────────────────
  //
  // These four carry MORE weight than anything above them, because the
  // platform-admin design deliberately does not rest on a Postgres role.
  // DATABASE_URL connects as `playerz`, which is rolsuper AND rolbypassrls,
  // so a role-based guarantee is not one this repo currently has. Triggers
  // fire for the owner and the superuser alike; that is why they were chosen.
  // Drop one and the accountability it enforces is gone, silently, because no
  // application code ever attempts the thing it forbids.
  {
    name: 'platform_audit_attribution_trg (forgery / omission)',
    drop: /DROP TRIGGER\s+(?:IF EXISTS\s+)?"?platform_audit_attribution_trg/i,
    recreate: /CREATE TRIGGER\s+"?platform_audit_attribution_trg/i,
    why: 'without it a platform audit row can be forged, attributed to someone else, or simply never written',
  },
  {
    name: 'platform_audit_append_only_trg',
    drop: /DROP TRIGGER\s+(?:IF EXISTS\s+)?"?platform_audit_append_only_trg/i,
    recreate: /CREATE TRIGGER\s+"?platform_audit_append_only_trg/i,
    why: 'the record of who read another club’s data must not be editable by the person who read it',
  },
  {
    name: 'platform_admin_grant_immutable_trg',
    drop: /DROP TRIGGER\s+(?:IF EXISTS\s+)?"?platform_admin_grant_immutable_trg/i,
    recreate: /CREATE TRIGGER\s+"?platform_admin_grant_immutable_trg/i,
    why: 'without it expiresAt is advisory — anyone reaching the table can push it forward or widen capabilities',
  },
  {
    name: 'platform_admin_grant_one_live_idx (PARTIAL unique index)',
    drop: /DROP INDEX\s+(?:IF EXISTS\s+)?"?platform_admin_grant_one_live_idx/i,
    recreate: /CREATE UNIQUE INDEX\s+(?:IF NOT EXISTS\s+)?"?platform_admin_grant_one_live_idx/i,
    why: 'overlapping live grants make "what could this person do?" unanswerable',
  },
];

/** A DROP inside a comment is documentation, not a statement. */
function executableLines(sql: string): string[] {
  const out: string[] = [];
  let inBlock = false;

  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('--')) continue;
    out.push(line);
  }

  return out;
}

describe('migration safety', () => {
  const migrations = globSync('prisma/migrations/**/migration.sql').map((f) => f.toString());

  it('the scan found the migration history', () => {
    // A broken glob makes the whole ratchet vacuous.
    expect(migrations.length).toBeGreaterThanOrEqual(5);
  });

  it.each(migrations)('%s does not destroy a protected object', (file) => {
    const sql = readFileSync(file, 'utf8');
    const body = executableLines(sql).join('\n');

    for (const p of PROTECTED) {
      if (!p.drop.test(body)) continue;
      if (p.recreate.test(body)) continue; // dropped AND rebuilt — fine

      throw new Error(
        `${file} destroys ${p.name} and does not recreate it.\n\n` +
          `  Why that matters: ${p.why}.\n\n` +
          `Prisma CANNOT MODEL this object, so \`migrate diff\` sees it in the live\n` +
          `database, does not find it in the schema, and proposes removing it. The diff\n` +
          `looks routine. This has already happened three times (P13, P15, P16).\n\n` +
          `If the change is intentional, recreate the object in the same migration.\n` +
          `If it is not — and it almost certainly is not — delete the statement.`,
      );
    }
  });

  it('the protected objects still exist in the final schema', () => {
    // The ratchet above catches a DROP. This catches the object never having
    // been created at all — e.g. a migration folder deleted by hand.
    const all = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

    expect(all).toMatch(/ADD CONSTRAINT\s+booking_no_overlap/i);
    expect(all).toMatch(/ADD CONSTRAINT\s+coach_no_overlap/i);
    expect(all).toMatch(/CREATE INDEX\s+(?:IF NOT EXISTS\s+)?"?venue_geog_idx"?/i);
    // Both append-only triggers, for the same reason.
    expect(all).toMatch(/CREATE TRIGGER\s+"?ledger_append_only/i);
    expect(all).toMatch(/CREATE TRIGGER\s+"?audit_append_only_trg/i);
  });

  it('every protected object names something that exists in the migrations', () => {
    // A typo in a pattern is INVISIBLE: the regex never matches, the ratchet
    // passes on every migration, and the object it claims to guard is
    // unguarded. So each entry must be able to point at the statement that
    // created the thing it protects.
    //
    // `booking_no_overlap` is the one entry whose recreate pattern is an
    // alternation ending in `RENAME COLUMN` — it still matches real SQL, so it
    // needs no exemption here.
    const all = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

    const unmatched = PROTECTED.filter((p) => !p.recreate.test(all)).map((p) => p.name);

    expect(unmatched).toEqual([]);
  });
});
