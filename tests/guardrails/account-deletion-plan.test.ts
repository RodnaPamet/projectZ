import { globSync, readFileSync } from 'node:fs';

import { DELETION_PLAN, NOT_PERSONAL } from '@/lib/account/deletion-plan';

/**
 * EVERY USER REFERENCE AND EVERY PERSONAL COLUMN IS IN THE DELETION PLAN (#370).
 *
 * Deleting an account touches every table that names a person, and a table
 * added next month will name one too. Nothing in the deletion code can notice
 * that by itself: a new `userId` column simply survives every deletion, with
 * the person's data in it, and nobody finds out.
 *
 * So the schema is parsed here, and every one of these must be decided in
 * `src/lib/account/deletion-plan.ts` (delete, anonymise, or keep with a
 * reason), or listed in `NOT_PERSONAL` with what it is:
 *
 *   - every relation to `User` (its foreign key column), and every relation
 *     field on `User` (the model it leads to);
 *   - every column that names a user by id without a relation, which most of
 *     them do (`bookedByUserId`, `authorUserId`, `senderId`, …);
 *   - every column that can hold personal data by its name: a name, an email,
 *     a phone, a picture, an address, free text, an IP address or a user
 *     agent, a device, a credential.
 *
 * A text parse of prisma/schema, like `prisma-schema-models.ts`, because the
 * schema is the source of truth the generated client is derived from.
 */

interface Field {
  model: string;
  name: string;
  type: string;
  /** The scalar columns of a relation: `@relation(fields: [userId])`. */
  relationFields: string[];
}

function parseFields(): Field[] {
  const out: Field[] = [];
  for (const file of globSync('prisma/schema/*.prisma')) {
    const src = readFileSync(file.toString(), 'utf8');
    const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const [, model, body] = m;
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
const models = new Set(fields.map((f) => f.model));

/** A scalar column that names a user by id. */
const USER_ID_COLUMN = /^(userId|[A-Za-z]+UserId|[A-Za-z]+ById|senderId|blockerId|blockedId)$/;

/** A column whose name says it can hold personal data. */
const PERSONAL_COLUMN =
  /(email|phone|name$|^name|displayName|avatar|image|photo|picture|ipAddress|userAgent|^bio$|birth|preferredHand|addressLine|^notes$|^body$|^message$|^tags$|deviceName|deviceToken|^endpoint$|p256dh|^auth$|secret|tokenHash|codeHash|passwordHash|TokenEnc$|externalAthleteId|^lat$|^lng$|Lat$|Lng$|^reason$|^details(Json)?$|ReasonJson$)/i;

const isScalarString = (type: string) => /^(String|Json|Decimal|DateTime)(\?|\[\])?$/.test(type);

/** Every column the plan must decide, as `Model.field`. */
function candidates(): Set<string> {
  const out = new Set<string>();
  for (const f of fields) {
    // A relation to User: its foreign key column.
    if (/^User\??$/.test(f.type)) {
      for (const fk of f.relationFields) out.add(`${f.model}.${fk}`);
      continue;
    }
    if (!isScalarString(f.type)) continue;
    if (USER_ID_COLUMN.test(f.name) || PERSONAL_COLUMN.test(f.name)) {
      out.add(`${f.model}.${f.name}`);
    }
  }
  return out;
}

/** The models `User`'s relation fields lead to. */
function userRelationTargets(): string[] {
  return fields
    .filter((f) => f.model === 'User' && models.has(f.type.replace(/[?[\]]/g, '')))
    .map((f) => f.type.replace(/[?[\]]/g, ''));
}

function covered(key: string): boolean {
  const [model, field] = key.split('.') as [string, string];
  if (NOT_PERSONAL[key]) return true;
  return DELETION_PLAN.some(
    (e) =>
      e.model === model &&
      (e.field === field || (e.field === undefined && e.action !== 'anonymise')),
  );
}

describe('the account deletion plan covers the schema (#370)', () => {
  it('the parse found the schema', () => {
    // Without this, a broken glob makes every assertion below vacuous.
    expect(models.size).toBeGreaterThan(50);
    expect(models.has('User')).toBe(true);
    expect(candidates().size).toBeGreaterThan(60);
  });

  it('every relation to User, every user-id column and every personal column is decided', () => {
    const missing = [...candidates()].filter((k) => !covered(k)).sort();
    if (missing.length > 0) {
      throw new Error(
        `These columns name a person or can hold personal data, and nothing says what an\n` +
          `account deletion does to them:\n\n` +
          missing.map((k) => `  ${k}`).join('\n') +
          `\n\nAdd each to DELETION_PLAN in src/lib/account/deletion-plan.ts (delete, anonymise,\n` +
          `or keep, with the reason), make deleteAccount do it, and extend\n` +
          `tests/integration/account-deletion.test.ts. A column that holds no person's data\n` +
          `goes in NOT_PERSONAL with what it is.`,
      );
    }
  });

  it('every model User leads to is in the plan', () => {
    const planned = new Set(DELETION_PLAN.map((e) => e.model));
    const missing = userRelationTargets().filter((m) => !planned.has(m));
    expect(missing).toEqual([]);
  });

  it('every entry names a model and a column that exist, and says why', () => {
    const byKey = new Set(fields.map((f) => `${f.model}.${f.name}`));
    const stale = DELETION_PLAN.filter(
      (e) => !models.has(e.model) || (e.field !== undefined && !byKey.has(`${e.model}.${e.field}`)),
    ).map((e) => `${e.model}.${e.field ?? '*'}`);
    expect(stale).toEqual([]);

    const staleNotPersonal = Object.keys(NOT_PERSONAL).filter((k) => !byKey.has(k));
    expect(staleNotPersonal).toEqual([]);

    const unexplained = DELETION_PLAN.filter((e) => e.reason.trim().length < 10).map(
      (e) => `${e.model}.${e.field ?? '*'}`,
    );
    expect(unexplained).toEqual([]);
  });

  it('nothing is both in the plan and called not personal', () => {
    const planned = new Set(
      DELETION_PLAN.filter((e) => e.field).map((e) => `${e.model}.${e.field}`),
    );
    expect(Object.keys(NOT_PERSONAL).filter((k) => planned.has(k))).toEqual([]);
  });

  it('no column is decided twice', () => {
    const keys = DELETION_PLAN.map((e) => `${e.model}.${e.field ?? '*'}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('the audit logs never receive an IP address or a user agent', () => {
    // The plan KEEPS audit_entry.ipAddress/userAgent and platform_audit_entry's,
    // and P52 gives only account_security_event an erasure path, on the
    // grounds that nothing writes the other two. A caller that starts passing
    // them makes that false: the deletion would leave an address behind in an
    // append-only table it cannot touch. Extend P52's erasure first.
    const offenders: string[] = [];
    const code = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
    for (const file of globSync('src/**/*.{ts,tsx}').map((f) => f.toString())) {
      if (file === 'src/lib/audit.ts' || file === 'src/lib/db/platform-admin-context.ts') continue;
      const src = code(readFileSync(file, 'utf8'));
      if (!/\b(appendAuditEntr\w*|runAsPlatformAdmin|asPlatformAdmin)\(/.test(src)) continue;
      if (/^\s*(ipAddress|userAgent)\s*:/m.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the net catches what it is for', () => {
    for (const name of ['userId', 'bookedByUserId', 'invitedById', 'senderId', 'blockedId']) {
      expect(USER_ID_COLUMN.test(name)).toBe(true);
    }
    for (const name of ['email', 'guestPhone', 'displayName', 'avatarUrl', 'ipAddress', 'notes']) {
      expect(PERSONAL_COLUMN.test(name)).toBe(true);
    }
    for (const name of ['startTs', 'status', 'totalCents', 'tenantId', 'userSessionId']) {
      expect(USER_ID_COLUMN.test(name) || PERSONAL_COLUMN.test(name)).toBe(false);
    }
    // A model-level anonymise does not cover a column: it has to say which.
    expect(
      DELETION_PLAN.some((e) => e.model === 'User' && !e.field && e.action === 'anonymise'),
    ).toBe(true);
  });
});
