import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * STRUCTURAL TENANT ISOLATION.
 *
 * RLS is the guarantee, and it fails CLOSED — a query that forgets its
 * tenant filter returns zero rows rather than another tenant's data. That
 * is the right failure mode, and it is exactly why this ratchet exists.
 *
 * Because "returns zero rows" is INVISIBLE. The endpoint 200s with an empty
 * list. No exception, no log line, no failing test — the page just says "no
 * bookings yet" to a customer who has twelve. And the moment somebody runs
 * that same repository from a job or an admin path that legitimately uses
 * `app_superuser` (which BYPASSES RLS), the missing filter stops being a
 * silent empty list and becomes a genuine cross-tenant leak.
 *
 * So: every Prisma call in a repository must carry an explicit `tenantId`,
 * even though RLS would add it anyway. Belt AND braces, enforced by the
 * build.
 */

/**
 * GLOBAL BY DESIGN — these models have no tenantId at all.
 *
 * `User` / `PlayerProfile` / `SkillRatingHistory`: a player is one identity
 * with one rating across every club they play at (see P04).
 * `sessionParticipant`: a pure join table, reachable only through an
 * open_play_session row that RLS already gates.
 */
const GLOBAL_MODELS = new Set([
  'user',
  'playerProfile',
  'skillRatingHistory',
  'sessionParticipant',
  'venueOrg', // keyed on its own id, not a tenantId column
  'tenantMembership', // the membership IS the tenant link

  // ── P15 messaging ──────────────────────────────────────────────────
  //
  // `userBlock` is GLOBAL by design. If a block were tenant-scoped, someone
  // you blocked at one venue could message you from another — that is not a
  // blocking feature, it is a loophole with extra steps.
  'userBlock',
  //
  // ── P29 APNs ───────────────────────────────────────────────────────
  //
  // `deviceToken` is user-scoped, exactly like `pushSubscription`: a phone
  // belongs to a PERSON, and it receives their notifications at every club
  // they belong to. Its RLS policy is keyed on app.user_id and does not
  // mention a tenant, so a tenantId filter here would match nothing — the
  // column does not exist.
  'deviceToken',
  //
  // `conversation.tenantId` is NULLABLE: a DM between two players who met at
  // different clubs belongs to no tenant. Its RLS policy is asymmetric (the
  // P04 UserSession shape) — readable when null, never writable into a tenant
  // that isn't yours.
  'conversation',
  //
  // These two hang off a conversation, which RLS already gates. Their access
  // control is PARTICIPANT-BASED and enforced in the usecase layer
  // (assertActiveParticipant), because RLS cannot express "is this user a
  // participant" without a join that would be a performance disaster on every
  // message read.
  'conversationParticipant',
  'chatMessage',
]);

/** Prisma calls that read or mutate rows and therefore need scoping. */
const SCOPED_CALLS = [
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  // `groupBy` was absent, and it is the aggregate form MOST likely to be used
  // for reporting — a read that returns rows summarised across whatever the
  // where clause admits. An unscoped one run as app_superuser sums every
  // tenant's data into a single number and looks entirely plausible.
  'groupBy',
] as const;

const ALLOW = /guardrail-allow:\s*cross-tenant/;

interface Finding {
  file: string;
  line: number;
  model: string;
  call: string;
  snippet: string;
}

/** `db.booking.findMany({` → { model: 'booking', call: 'findMany' } */
const CALL_RE = new RegExp(`\\b(?:db|tx|prisma)\\.(\\w+)\\.(${SCOPED_CALLS.join('|')})\\s*\\(`);

/** Index just past the paren closing the first `(` in `s`. */
function callEnd(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

describe('structural tenant isolation', () => {
  const files = globSync('src/app-layer/repositories/**/*.ts')
    .concat(globSync('src/app-layer/usecases/**/*.ts'))
    .map((f) => f.toString());

  it('the scan found the repository/usecase layer', () => {
    // A broken glob would make the whole ratchet vacuous — it would pass by
    // finding nothing to check.
    expect(files.length).toBeGreaterThan(0);
  });

  it('every tenant-scoped Prisma call carries an explicit tenantId filter', () => {
    const findings: Finding[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');

      // Track block comments. Without this, the doc comment in booking.ts —
      // which shows the WRONG pattern precisely so nobody writes it — is
      // itself reported as a violation. A guardrail that flags its own
      // documentation trains people to ignore it.
      let inBlockComment = false;

      lines.forEach((line, i) => {
        const trimmed = line.trim();

        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          return;
        }
        if (trimmed.startsWith('/*')) {
          if (!trimmed.includes('*/')) inBlockComment = true;
          return;
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

        const m = CALL_RE.exec(line);
        if (!m) return;

        const [, model, call] = m;
        if (GLOBAL_MODELS.has(model!)) return;
        if (ALLOW.test(line)) return;

        // Read the whole call, which may span many lines.
        const window = lines.slice(i, i + 30).join('\n');
        const body = window.slice(0, callEnd(window));

        // The justification is normally written ABOVE the call — that is
        // where a reader looks for it. Accept it there as well as inline.
        const preamble = lines.slice(Math.max(0, i - 6), i).join('\n');

        if (ALLOW.test(body) || ALLOW.test(preamble)) return;
        if (/\btenantId\b/.test(body)) return;

        // A lookup by primary key is inherently scoped — the id IS the row.
        if (/\bwhere:\s*\{\s*id:/.test(body) && call !== 'findMany') return;

        findings.push({
          file,
          line: i + 1,
          model: model!,
          call: call!,
          snippet: line.trim().slice(0, 90),
        });
      });
    }

    if (findings.length > 0) {
      const report = findings
        .map((f) => `  ${f.file}:${f.line}\n    ${f.model}.${f.call} — ${f.snippet}`)
        .join('\n');

      throw new Error(
        `${findings.length} Prisma call(s) with no tenantId filter:\n${report}\n\n` +
          `RLS would return ZERO ROWS here rather than another tenant's data — which is the\n` +
          `right failure mode, and precisely why this is dangerous: the endpoint 200s with an\n` +
          `empty list. No exception, no log, no failing test. The page tells a customer with\n` +
          `twelve bookings that they have none.\n\n` +
          `And the day this repository is called from a job or admin path running as\n` +
          `app_superuser — which BYPASSES RLS — the missing filter stops being a silent empty\n` +
          `list and becomes a real cross-tenant leak.\n\n` +
          `Fix: add \`tenantId\` to the where clause. If the query is DELIBERATELY\n` +
          `cross-tenant (e.g. public venue search), annotate it:\n` +
          `  // guardrail-allow: cross-tenant <reason>`,
      );
    }

    expect(findings).toHaveLength(0);
  });
});
