import { existsSync, globSync, readFileSync } from 'node:fs';

/**
 * A NEW ENUM VALUE SHIPS WITH ITS WAY BACK (#450).
 *
 * ═══ THE HAZARD ═══
 *
 * "Migrations here are additive, so the previous image runs against the new
 * schema" is true of the schema and false of the ROWS. Prisma refuses to read
 * an enum value its client was not generated with: the whole query fails with
 * `Value 'X' not found in enum 'Y'`. Measured with the pre-P51 client against
 * a database holding one squash court: the venue list, its filters, `/me`, a
 * player's bookings and the admin's courts all failed.
 *
 * So rolling back to the previous image, once a row uses a value that image
 * has never heard of, breaks every read that maps that column, at the moment
 * somebody is already rolling back because something else went wrong.
 *
 * ═══ THE RULE ═══
 *
 * A migration that adds an enum value ships with:
 *
 *   deploy/rollback/pNN-park.sql     moves the rows that use the new value out
 *                                    of the old image's sight, before it starts
 *   deploy/rollback/pNN-unpark.sql   puts them back when rolling forward again
 *   "Rolling back past pNN"          the section in docs/deploy-gcp.md that
 *                                    says when to run them
 *   tests/integration/pNN-rollback-park.test.ts
 *                                    runs both against a real database
 *
 * P51 was the first to have them; this makes the habit a rule, so the next
 * `ADD VALUE` cannot merge without its own.
 */

/** `ALTER TYPE "X" ADD VALUE 'Y'`, outside SQL comments. */
function addedValues(sql: string): Array<{ type: string; value: string }> {
  const code = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const out: Array<{ type: string; value: string }> = [];
  const re = /ALTER\s+TYPE\s+"?(\w+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'(\w+)'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push({ type: m[1]!, value: m[2]! });
  return out;
}

const MIGRATIONS = globSync('prisma/migrations/*/migration.sql')
  .map((f) => f.toString())
  .sort()
  .map((file) => {
    const dir = file.split('/').at(-2)!;
    return { dir, added: addedValues(readFileSync(file, 'utf8')) };
  })
  .filter((m) => m.added.length > 0);

/**
 * Added before the rule (P51), and long past the reach of a rollback: every
 * image that could still be rolled back to was generated with these values, so
 * none of them can meet a value it does not know. No park script, on purpose.
 *
 * Nothing new belongs here. A migration written today takes the four files.
 */
const BEFORE_THE_RULE: Record<string, string> = {
  '20260712120000_p13_resource_generalization':
    'ResourceType and SportType values from July 2026; every image since knows them',
  '20260712191000_membership_expired_status':
    'MembershipStatus.EXPIRED from July 2026; every image since knows it',
  '20260929160000_p36_review_moderate_capability':
    'PlatformCapability.REVIEW_MODERATE, September 2026; every image since knows it',
  '20261006170000_p46_notifications_outbox':
    'the BOOKING_PLAYER_* notification kinds; in every image since the bell shipped',
  '20261007093000_p48_club_fee_ledger':
    'the club fee ledger values; in every image since the fee shipped',
  '20261007130000_p50_contact_requests':
    'CONTACT_REQUEST and CONTACT_READ; in every image since the enquiry form shipped',
};

/** `p67` from `20261014000000_p67_report_game_note`. */
const phase = (dir: string) => /_(p\d+[a-z]?)_/.exec(dir)?.[1] ?? null;

const RULED = MIGRATIONS.filter((m) => !(m.dir in BEFORE_THE_RULE));

describe('a new enum value ships with its way back (#450)', () => {
  it('the scan found the migrations that add enum values', () => {
    // A broken glob or regex would make every check below pass on nothing.
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(11);
    expect(RULED.map((m) => phase(m.dir))).toEqual(
      expect.arrayContaining(['p51', 'p54', 'p55', 'p61', 'p67']),
    );
    expect(addedValues(`ALTER TYPE "ModerationSubject" ADD VALUE 'OPEN_GAME_NOTE';`)).toEqual([
      { type: 'ModerationSubject', value: 'OPEN_GAME_NOTE' },
    ]);
    expect(addedValues(`-- ALTER TYPE "X" ADD VALUE 'COMMENTED_OUT';`)).toEqual([]);
    expect(
      addedValues(`ALTER TYPE "SportType" ADD VALUE IF NOT EXISTS 'SQUASH' AFTER 'A';`),
    ).toEqual([{ type: 'SportType', value: 'SQUASH' }]);
  });

  it.each(RULED.map((m) => [m.dir, m] as const))(
    '%s has its park and unpark scripts, its section in the deploy doc, and its test',
    (dir, m) => {
      const p = phase(dir);
      if (!p) {
        throw new Error(
          `${dir} adds an enum value and its name has no phase (…_pNN_…), so its\n` +
            `rollback scripts cannot be found. Name the migration with its phase.`,
        );
      }
      const park = `deploy/rollback/${p}-park.sql`;
      const unpark = `deploy/rollback/${p}-unpark.sql`;
      const test = `tests/integration/${p}-rollback-park.test.ts`;
      const doc = readFileSync('docs/deploy-gcp.md', 'utf8');

      const missing = [
        ...[park, unpark, test].filter((f) => !existsSync(f)),
        ...(new RegExp(`^### Rolling back past ${p}\\b`, 'm').test(doc)
          ? []
          : [`docs/deploy-gcp.md: a "### Rolling back past ${p}" section`]),
      ];
      if (missing.length > 0) {
        throw new Error(
          `${dir} adds ${m.added.map((a) => `${a.type}.${a.value}`).join(', ')}.\n\n` +
            `The image before it cannot read a row that uses a new enum value: Prisma fails\n` +
            `the whole query (#450). So the migration ships with its way back. Missing:\n\n` +
            missing.map((f) => `  ${f}`).join('\n') +
            `\n\nCopy the shape from deploy/rollback/p67-park.sql and -unpark.sql, the\n` +
            `"Rolling back past p67" section, and tests/integration/p67-rollback-park.test.ts.`,
        );
      }

      // The park script deals with every value the migration added. It names
      // each one, or reads them from the catalogue by the enum's name.
      const parkSql = readFileSync(park, 'utf8');
      const unhandled = m.added.filter(
        (a) => !parkSql.includes(`'${a.value}'`) && !parkSql.includes(a.type),
      );
      expect({ park, unhandled }).toEqual({ park, unhandled: [] });
    },
  );

  it('the list of migrations from before the rule is exact, and each says why', () => {
    const adding = new Set(MIGRATIONS.map((m) => m.dir));
    // A name that adds no enum value is an exemption for nothing.
    expect(Object.keys(BEFORE_THE_RULE).filter((dir) => !adding.has(dir))).toEqual([]);
    expect(
      Object.entries(BEFORE_THE_RULE)
        .filter(([, why]) => why.trim().length < 30)
        .map(([dir]) => dir),
    ).toEqual([]);
    // Nothing after P51 hides in it: the rule started there.
    expect(
      Object.keys(BEFORE_THE_RULE).filter((dir) => dir > '20261007150000_p51_squash_karting'),
    ).toEqual([]);
  });
});
