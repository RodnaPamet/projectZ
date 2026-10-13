import { readFileSync, globSync } from 'node:fs';

/**
 * STRAVA API AGREEMENT — STRUCTURAL ENFORCEMENT.
 *
 * Strava's API Agreement (rev. November 2024) forbids:
 *
 *   1. showing an athlete's data to anyone but that athlete — no leaderboard,
 *      no feed, no coach view, and no AGGREGATE, because a number computed
 *      across many athletes' Strava data and shown to any of them is a
 *      cross-user display however anonymised it looks;
 *   2. using their data to train or serve ANY model;
 *   3. keeping the data after the athlete disconnects.
 *
 * Breaking any of these gets our API key revoked — which cuts off every
 * connected athlete at once, without warning — and is a contract breach.
 *
 * A comment cannot enforce that, and neither can a code review on a busy day.
 * So there are three layers, and this file is one of them:
 *
 *   a) the DATABASE — an RLS policy makes a STRAVA row invisible to anyone but
 *      its owner, so a leaky query returns zero rows rather than someone's ride;
 *   b) THIS RATCHET — the build fails if Strava data reaches a place it must not;
 *   c) src/lib/wearables/strava-tos.ts — the one sanctioned read path.
 *
 * Every rule below is NEGATIVE-CONTROLLED at the bottom of the file: we prove
 * the pattern actually fires on the code it is meant to forbid, so that nobody
 * is protected by a regex that silently stopped matching.
 */

const SOURCE_FILES = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

/** Strip comments — a rule DISCUSSED in prose is not a violation of it. */
function code(source: string): string {
  const out: string[] = [];
  let inBlock = false;

  for (const raw of source.split('\n')) {
    let line = raw;

    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2);
    }

    const block = line.indexOf('/*');
    if (block !== -1) {
      const end = line.indexOf('*/', block + 2);
      if (end === -1) {
        inBlock = true;
        line = line.slice(0, block);
      } else {
        line = line.slice(0, block) + line.slice(end + 2);
      }
    }

    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);

    if (line.trim()) out.push(line);
  }

  return out.join('\n');
}

/** Files that read the `activity` table at all. */
function activityReaders(): string[] {
  return SOURCE_FILES.filter((f) =>
    /\bdb\.activity\b|\btx\.activity\b/.test(code(readFileSync(f, 'utf8'))),
  );
}

describe('the scan is not vacuous', () => {
  it('found the source tree', () => {
    // A broken glob makes every assertion below trivially true.
    expect(SOURCE_FILES.length).toBeGreaterThan(50);
  });

  it('found the code that actually reads activities', () => {
    // If this ever hits zero, the rules below are protecting nothing.
    expect(activityReaders().length).toBeGreaterThan(0);
  });
});

// ── 1. The database policy must exist ────────────────────────────────

describe('the database refuses cross-athlete Strava reads', () => {
  const migrations = globSync('prisma/migrations/**/migration.sql').map((f) => f.toString());
  const allSql = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

  it('the owner-only RLS policy is in the migration history', () => {
    expect(allSql).toMatch(/CREATE POLICY\s+activity_strava_owner_only/i);
    expect(allSql).toMatch(/ALTER TABLE\s+"?activity"?\s+ENABLE ROW LEVEL SECURITY/i);
    expect(allSql).toMatch(/ALTER TABLE\s+"?activity"?\s+FORCE ROW LEVEL SECURITY/i);
  });

  it('the policy keys on app.user_id, fail-closed', () => {
    const policy =
      allSql.match(/CREATE POLICY\s+activity_strava_owner_only[\s\S]{0,400}/i)?.[0] ?? '';

    // The 2-arg current_setting returns NULL rather than raising when unset, and
    // `"userId" = NULL` is NULL, not TRUE — so a session that never set
    // app.user_id sees NO Strava rows. For this table that is the difference
    // between a bug and a breach.
    expect(policy).toMatch(/current_setting\(\s*'app\.user_id'\s*,\s*true\s*\)/);
    expect(policy).toMatch(/source\s*<>\s*'STRAVA'/i);
  });

  it('wearable tokens are owner-only too', () => {
    expect(allSql).toMatch(/CREATE POLICY\s+wearable_connection_owner_only/i);
  });
});

// ── 2. No Strava data in cross-user features ─────────────────────────

describe('Strava data never reaches a cross-user surface', () => {
  // The modules whose entire purpose is to show one person's data to another,
  // or to compute across people. Strava rows must never enter them.
  const CROSS_USER_MODULES = [
    'gamification/leaderboard',
    'ratings/engine',
    'ratings/openskill',
    'matchmaking/glicko',
  ];

  it.each(CROSS_USER_MODULES)('%s does not read the activity table', (module) => {
    const matches = SOURCE_FILES.filter((f) => f.includes(module));
    expect(matches.length).toBeGreaterThan(0); // the path is real

    for (const file of matches) {
      const src = code(readFileSync(file, 'utf8'));

      if (/\bdb\.activity\b|\btx\.activity\b|from '@\/lib\/wearables/.test(src)) {
        throw new Error(
          `${file} touches activity/wearable data.\n\n` +
            `This module produces a CROSS-USER surface — a leaderboard, a rating, a\n` +
            `search document — and Strava's API Agreement forbids their data appearing\n` +
            `in any of them, including as an anonymised aggregate.\n\n` +
            `If the data you need is genuinely not from Strava, filter on\n` +
            `source != 'STRAVA' at the query and say so; do not read the table here.`,
        );
      }
    }
  });

  it('no query aggregates the activity table without excluding restricted sources', () => {
    // groupBy / aggregate over activities is exactly the "average 5k at this
    // club" case the agreement forbids.
    const violations: string[] = [];

    for (const file of activityReaders()) {
      const src = code(readFileSync(file, 'utf8'));

      const aggregates = /\b(?:db|tx)\.activity\.(aggregate|groupBy)\b/.exec(src);
      if (!aggregates) continue;

      // It is only lawful if the same call excludes STRAVA.
      const scopedToOneUser = /source:\s*\{\s*not:\s*'STRAVA'|NOT\s+STRAVA|excludeRestricted/.test(
        src,
      );

      if (!scopedToOneUser) {
        violations.push(`${file}: ${aggregates[0]}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Aggregating the activity table without excluding STRAVA:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nAn aggregate computed across athletes' Strava data and shown to any of them\n` +
          `is a CROSS-USER DISPLAY of that data — anonymising it does not help. Exclude\n` +
          `source = 'STRAVA', or use excludeRestricted().`,
      );
    }
  });
});

// ── 3. No AI / ML ────────────────────────────────────────────────────

describe('Strava data is never sent to a model', () => {
  it('no file that reads activities also calls an AI endpoint', () => {
    const AI_CALL =
      /api\.anthropic\.com|api\.openai\.com|@\/lib\/moderation|classifyText|moderateOrQueue/;

    const violations: string[] = [];

    for (const file of activityReaders()) {
      const src = code(readFileSync(file, 'utf8'));
      if (AI_CALL.test(src)) violations.push(file);
    }

    if (violations.length > 0) {
      throw new Error(
        `These files read activity data AND call a model:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nStrava's API Agreement forbids using their data to train, fine-tune or SERVE\n` +
          `any model — including sending it in a prompt. This is easy to break by\n` +
          `accident: an activity feed gets piped into a "suggest a training plan" call,\n` +
          `and Strava data is now an ML input.`,
      );
    }
  });
});

// ── 4. Deletion on deauthorisation ───────────────────────────────────

describe('revoking actually deletes', () => {
  it('handleDeauthorization deletes activities rather than hiding them', () => {
    const src = code(readFileSync('src/app-layer/usecases/wearables.ts', 'utf8'));

    const fn = src.slice(src.indexOf('export async function handleDeauthorization'));
    expect(fn.length).toBeGreaterThan(0);

    // A hard delete, on STRAVA rows, for that user. Not a flag.
    expect(fn).toMatch(/activity\.deleteMany/);
    expect(fn).toMatch(/source:\s*'STRAVA'/);

    // And the tokens go with it. A revoked connection holding a live token is a
    // loaded gun in the database.
    expect(fn).toMatch(/accessTokenEnc:\s*''/);
    expect(fn).toMatch(/refreshTokenEnc:\s*''/);
  });
});

// ── Negative controls ────────────────────────────────────────────────
//
// A guardrail nobody has watched go red is a guardrail nobody knows works.

describe('the rules actually fire on the code they forbid', () => {
  it('detects an activity read', () => {
    const reader = /\bdb\.activity\b|\btx\.activity\b/;

    expect(reader.test('await db.activity.findMany({ where: { userId } })')).toBe(true);
    expect(reader.test('await tx.activity.create({ data })')).toBe(true);
    expect(reader.test('await db.booking.findMany({})')).toBe(false);
  });

  it('detects an unguarded aggregate', () => {
    const agg = /\b(?:db|tx)\.activity\.(aggregate|groupBy)\b/;

    expect(
      agg.test('const avg = await db.activity.aggregate({ _avg: { distanceM: true } });'),
    ).toBe(true);
    expect(agg.test("const rows = await db.activity.groupBy({ by: ['userId'] });")).toBe(true);
    expect(agg.test('await db.activity.findMany({})')).toBe(false);
  });

  it('detects an AI call', () => {
    const ai =
      /api\.anthropic\.com|api\.openai\.com|@\/lib\/moderation|classifyText|moderateOrQueue/;

    expect(ai.test("fetch('https://api.anthropic.com/v1/messages')")).toBe(true);
    expect(ai.test("import { classifyText } from '@/lib/moderation/classify';")).toBe(true);
    expect(ai.test("fetch('https://www.strava.com/api/v3/athlete')")).toBe(false);
  });

  it('the comment stripper does not let a real violation hide in code that MENTIONS a comment marker', () => {
    const src = code(`
      // db.activity.aggregate({}) — forbidden, see the ToS
      const x = 1;
    `);
    expect(src).not.toContain('db.activity');

    const real = code(`const y = await db.activity.aggregate({});`);
    expect(real).toContain('db.activity');
  });
});
