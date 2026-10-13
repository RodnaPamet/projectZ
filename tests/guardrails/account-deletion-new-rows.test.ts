import { globSync, readFileSync } from 'node:fs';

import { DELETION_PLAN, NEW_ROWS } from '@/lib/account/deletion-plan';

import { reachableFromEntryPoints } from './reachable-from-routes';

/**
 * A DELETED ACCOUNT GAINS NOTHING NEW, AND A MODULE THAT SHIPS HAS TO SAY SO (#465).
 *
 * ═══ THE GAP THIS CLOSES ═══
 *
 * `account-deletion-plan.test.ts` makes every table that names a person decide
 * what a deletion does to the rows that EXIST. Two rules about what comes
 * AFTER were left to memory:
 *
 *   1. Nothing new may be written for a deleted account. P52 gave seven tables
 *      a trigger for that. Messages and open play shipped later and got none,
 *      because nothing told their pull requests to add one (P69 did).
 *   2. An account with something upcoming cannot be deleted. The refusal reads
 *      court bookings and places. A coach lesson or a tournament entry would
 *      not be read the day those modules ship, and the coach would never hear.
 *
 * So both are declarations in `src/lib/account/deletion-plan.ts` now
 * (`NEW_ROWS`, and `upcoming` on a plan entry), and this file holds them to
 * three things that cannot be argued with: the schema, the migrations, and
 * what a request can reach.
 *
 * ═══ WHAT "UNWRITTEN" MEANS, AND HOW IT IS CHECKED ═══
 *
 * A model nothing live writes needs no trigger yet. "Live" is the import walk
 * from everything Next.js runs (reachable-from-routes.ts), at module
 * granularity. A write is any of:
 *
 *   db.model.create( / createMany( / createManyAndReturn( / upsert(
 *   a nested write through a relation field:  players: { create: … }
 *   raw SQL:  INSERT INTO "table"
 *
 * The moment a reachable file does one of those to an `unwritten` model, the
 * build fails and names the three things the module's pull request owes.
 */

interface Field {
  model: string;
  name: string;
  type: string;
  relationFields: string[];
}

const tables = new Map<string, string>();

function parseFields(): Field[] {
  const out: Field[] = [];
  for (const file of globSync('prisma/schema/*.prisma')) {
    const src = readFileSync(file.toString(), 'utf8');
    const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const [, model, body] = m;
      tables.set(model!, /@@map\("([^"]+)"\)/.exec(body!)?.[1] ?? model!);
      for (const line of body!.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('//') || t.startsWith('@@') || t.startsWith('///')) continue;
        const [name, type] = t.split(/\s+/);
        if (!name || !type) continue;
        const rel = /@relation\([^)]*fields:\s*\[([^\]]*)\]/.exec(t);
        out.push({
          model: model!,
          name,
          type,
          relationFields: rel ? rel[1]!.split(',').map((s) => s.trim()) : [],
        });
      }
    }
  }
  return out;
}

const fields = parseFields();

/** The same net as the plan's guardrail: a relation to User, or a user id by name. */
const USER_ID_COLUMN = /^(userId|[A-Za-z]+UserId|[A-Za-z]+ById|senderId|blockerId|blockedId)$/;

function userColumns(): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    if (/^User\??$/.test(f.type)) {
      for (const fk of f.relationFields) out.add(`${f.model}.${fk}`);
    } else if (/^String(\?|\[\])?$/.test(f.type) && USER_ID_COLUMN.test(f.name)) {
      out.add(`${f.model}.${f.name}`);
    }
  }
  return [...out].sort();
}

/** `table.column` for every `account_not_deleted` trigger any migration creates. */
function triggersInMigrations(): Set<string> {
  const out = new Set<string>();
  const re =
    /CREATE TRIGGER\s+\w+\s+BEFORE INSERT OR UPDATE OF "(\w+)" ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION account_not_deleted\('(\w+)'\)/g;
  for (const file of globSync('prisma/migrations/*/migration.sql')) {
    const sql = readFileSync(file.toString(), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const [, updateOf, table, arg] = m;
      // The column the trigger fires on and the one the function reads must be
      // the same, or an UPDATE of the real column slips past it.
      if (updateOf !== arg) {
        throw new Error(
          `${file}: the trigger on "${table}" fires on "${updateOf}" but checks '${arg}'.`,
        );
      }
      out.add(`${table}.${arg}`);
    }
  }
  return out;
}

const reachable = [...reachableFromEntryPoints()]
  .filter((f) => f.startsWith('src/'))
  .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }));

/** The reachable files that write `model`, by any of the three ways. */
function liveWriters(model: string): string[] {
  const camel = model[0]!.toLowerCase() + model.slice(1);
  const relationNames = fields
    .filter((f) => f.type.replace(/[?[\]]/g, '') === model)
    .map((f) => f.name);
  const patterns = [
    new RegExp(`\\.${camel}\\.(create|createMany|createManyAndReturn|upsert)\\(`),
    new RegExp(`INSERT\\s+INTO\\s+"?${tables.get(model)}"?[\\s(]`, 'i'),
    ...[...new Set(relationNames)].map(
      (r) => new RegExp(`\\b${r}\\s*:\\s*\\{\\s*(create|createMany|connectOrCreate|upsert)\\b`),
    ),
  ];
  return reachable.filter(({ src }) => patterns.some((p) => p.test(src))).map(({ file }) => file);
}

const split = (key: string) => key.split('.') as [string, string];

describe('a deleted account gains nothing new (#465)', () => {
  const columns = userColumns();
  const triggers = triggersInMigrations();

  it('the parse found the schema, the migrations and the app', () => {
    // Without these a broken glob or resolver makes every check below vacuous.
    expect(columns.length).toBeGreaterThan(50);
    expect(triggers.size).toBeGreaterThanOrEqual(8);
    expect(triggers.has('booking.bookedByUserId')).toBe(true);
    expect(reachable.length).toBeGreaterThan(200);
    // The three kinds of write are each really detected.
    expect(liveWriters('Booking')).toContain('src/app-layer/usecases/booking.ts');
    expect(liveWriters('PlatformAuditEntry')).toContain('src/lib/db/platform-admin-context.ts');
    expect(liveWriters('BookingParticipant').length).toBeGreaterThan(0);
  });

  it('every column that names a user has its rule, and no rule is stale', () => {
    const undecided = columns.filter((c) => !NEW_ROWS[c]);
    const stale = Object.keys(NEW_ROWS).filter((c) => !columns.includes(c));
    if (undecided.length > 0) {
      throw new Error(
        `These columns name a user and say nothing about what happens after an account is deleted:\n\n` +
          undecided.map((c) => `  ${c}`).join('\n') +
          `\n\nAdd each to NEW_ROWS in src/lib/account/deletion-plan.ts:\n` +
          `  trigger    and add account_not_deleted('<column>') in a migration, if the\n` +
          `             row is the person's own or puts them in front of other people\n` +
          `  unwritten  if nothing a request can reach writes the model yet\n` +
          `  reason     if it only records who acted on somebody else's row, with why`,
      );
    }
    expect(stale).toEqual([]);
  });

  it('every `trigger` rule has its trigger in a migration, and every trigger is declared', () => {
    const declared = Object.entries(NEW_ROWS)
      .filter(([, r]) => r.held === 'trigger')
      .map(([key]) => {
        const [model, column] = split(key);
        return `${tables.get(model)}.${column}`;
      });

    const missing = declared.filter((t) => !triggers.has(t)).sort();
    if (missing.length > 0) {
      throw new Error(
        `NEW_ROWS says these are refused by the database, and no migration creates the trigger:\n\n` +
          missing.map((t) => `  ${t}`).join('\n') +
          `\n\nIn a new migration, as P69 does:\n\n` +
          `  CREATE TRIGGER <table>_account_not_deleted_trg\n` +
          `    BEFORE INSERT OR UPDATE OF "<column>" ON "<table>"\n` +
          `    FOR EACH ROW EXECUTE FUNCTION account_not_deleted('<column>');`,
      );
    }
    // The other way: a trigger nobody declared is a rule nobody can read here.
    expect([...triggers].filter((t) => !declared.includes(t)).sort()).toEqual([]);
  });

  it('nothing a request can reach writes an `unwritten` model', () => {
    const models = [
      ...new Set(
        Object.entries(NEW_ROWS)
          .filter(([, r]) => r.held === 'unwritten')
          .map(([key]) => split(key)[0]),
      ),
    ];
    const nowLive = models
      .map((model) => ({ model, files: liveWriters(model) }))
      .filter((m) => m.files.length > 0);

    if (nowLive.length > 0) {
      throw new Error(
        `These models were declared unwritten, and something a request can reach now writes them:\n\n` +
          nowLive.map((m) => `  ${m.model}\n      ${m.files.join('\n      ')}`).join('\n') +
          `\n\nThe module has shipped. Its pull request owes three things (#465):\n\n` +
          `  1. NEW_ROWS (src/lib/account/deletion-plan.ts): each of the model's user\n` +
          `     columns becomes \`trigger\` (with a migration) or a \`reason\`.\n` +
          `  2. If a row can be a FUTURE commitment (a lesson, a session, a match), its\n` +
          `     plan entry is \`upcoming: 'checked'\`, and the deletion's refusal reads it:\n` +
          `     upcoming() in src/app-layer/usecases/account-deletion.ts, the 409's\n` +
          `     details and the profile's list, each with its cure (cancel, leave, wait).\n` +
          `  3. tests/integration/account-deletion.test.ts proves both.`,
      );
    }
  });

  it('every `reason` says why, in a sentence', () => {
    const thin = Object.entries(NEW_ROWS)
      .filter(([, r]) => r.held === 'reason' && r.why.trim().length < 60)
      .map(([key]) => key);
    expect(thin).toEqual([]);
  });
});

describe('what must be cancelled or left before an account can go (#465)', () => {
  const flagged = DELETION_PLAN.filter((e) => e.upcoming);

  it('the plan flags the commitments, shipped and not', () => {
    expect(flagged.map((e) => `${e.model}.${e.field}:${e.upcoming}`).sort()).toEqual([
      'Booking.bookedByUserId:checked',
      'BookingParticipant.userId:checked',
      'CoachBooking.playerUserId:when-shipped',
      'TournamentEntry.playerUserId:when-shipped',
    ]);
  });

  it('a `checked` commitment is also refused by the database for a deleted account', () => {
    // The refusal reads the rows that exist. Without the trigger, one written
    // while the deletion commits lands after the check and is never seen.
    const unguarded = flagged
      .filter((e) => e.upcoming === 'checked')
      .map((e) => `${e.model}.${e.field}`)
      .filter((key) => NEW_ROWS[key]?.held !== 'trigger');
    expect(unguarded).toEqual([]);
  });

  it('a `when-shipped` commitment is still unwritten: shipping it fails the check above', () => {
    // If this fails, the module shipped and its entry was left `when-shipped`:
    // the deletion would let somebody go with a lesson or a match ahead.
    const shipped = flagged
      .filter((e) => e.upcoming === 'when-shipped')
      .map((e) => `${e.model}.${e.field}`)
      .filter((key) => NEW_ROWS[key]?.held !== 'unwritten');
    expect(shipped).toEqual([]);
  });

  it('the refusal reads what the plan says it reads', () => {
    // A text check, and only a tripwire: the proof is the integration suite,
    // which deletes an account with a booking and with a place ahead.
    const src = readFileSync('src/app-layer/usecases/account-deletion.ts', 'utf8');
    const start = src.indexOf('async function upcoming(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('listUpcomingBookingsForUser');
    expect(body).toContain('bookedByUserId: userId');
    expect(body).toContain('participants: { some: { userId } }');
  });
});
