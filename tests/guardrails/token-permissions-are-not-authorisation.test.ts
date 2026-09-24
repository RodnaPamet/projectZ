import { globSync, readFileSync } from 'node:fs';

/**
 * `token.permissions` and `token.role` are display-only. Nothing may authorise
 * on them.
 *
 * ═══ THE BUG THIS EXISTS TO PREVENT A SECOND TIME ═══
 *
 * `auth.ts` mints both from `memberships[0]` — whichever club the user joined
 * first. The middleware checked the permission a route required against that
 * frozen array, while separately (and correctly) verifying membership of the
 * club named in the URL. So an OWNER at club A who was a PLAYER at club B
 * passed both halves and could run owner-only mutations at B.
 *
 * The fix derives permissions from the membership matching the path. That is
 * one line, and one line is exactly what somebody re-introducing this would
 * change — plausibly while fixing something else, because reaching for
 * `token.permissions` is the obvious move when you need permissions and a
 * field called `permissions` is right there.
 *
 * So the rule is structural rather than advisory: outside the file that mints
 * them, these fields are not read.
 */

/** Reading `permissions`/`role` off something token- or session-shaped. */
const FORBIDDEN = /\b(?:token|session|claims|jwt|raw)(?:\.user)?\.(permissions|role)\b/;

/**
 * ONLY the file that MINTS them.
 *
 * ═══ WHY guard.ts, middleware.ts AND context.ts ARE NOT HERE ═══
 *
 * They were, and that made this rule unable to catch the bug it exists for.
 *
 * Those three are the only files in the codebase that DECIDE authorisation, so
 * they are the only three places the one-line regression can be written. An
 * allowlist naming them exempts precisely its own subject. Demonstrated rather
 * than argued: inserting `if (token.permissions) return token.permissions` into
 * `permissionsForPath` — the exact cross-tenant escalation this rule describes,
 * where an OWNER at one club performs owner-only mutations at another — left
 * this suite passing.
 *
 * The original justification was that those files mention the fields in prose
 * and an allowlist entry "costs nothing". Both halves were wrong. `code()`
 * below already strips comments, so prose never matched; and the entries cost
 * the entire rule. Removing them on an unmodified tree leaves the suite green,
 * which is the proof they were buying nothing.
 *
 * If a genuine need arises to read these fields in an authorisation file, that
 * is the conversation this rule exists to force — not something to wave through
 * with a new entry here.
 */
const ALLOWED = new Set(['src/auth.ts']);

/** Strip comments, so prose about the rule is not mistaken for a breach. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('token permissions are not authorisation', () => {
  const files = globSync(['src/**/*.ts', 'src/**/*.tsx']);

  it('finds the mint site — proving the scanner actually looks', () => {
    // Without this, deleting `sourceFiles()`' contents, breaking the regex, or
    // pointing the glob at nothing all make the rule below pass by scanning
    // zero bytes. A guardrail that cannot fail is not a guardrail.
    expect(files.length).toBeGreaterThan(200);

    const auth = code(readFileSync('src/auth.ts', 'utf8'));
    expect(auth).toMatch(FORBIDDEN);
  });

  it('the allowlist names ONLY the mint site', () => {
    // The failure this rule actually suffered was not someone reading the
    // fields — it was the allowlist growing to cover the files that do. An
    // entry added here is indistinguishable from a fix, so the set is pinned:
    // widening it has to be a deliberate edit to this assertion, in a diff a
    // reviewer will see.
    expect([...ALLOWED]).toEqual(['src/auth.ts']);
  });

  it('would catch the escalation in an authorisation file', () => {
    // The regression is one line in permissionsForPath. This proves the
    // scanner reaches that file and that the pattern matches the shape the
    // regression takes — the two things the old allowlist quietly disabled.
    const guard = 'src/lib/auth/guard.ts';

    expect(files).toContain(guard);
    expect(ALLOWED.has(guard)).toBe(false);
    expect(FORBIDDEN.test('  if (token.permissions) return token.permissions;')).toBe(true);
  });

  it('is read nowhere else', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => FORBIDDEN.test(code(readFileSync(f, 'utf8'))));

    expect(offenders).toEqual([]);
  });
});
