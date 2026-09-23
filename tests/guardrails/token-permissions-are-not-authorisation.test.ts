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
 * `auth.ts` mints them. `guard.ts`, `context.ts` and `middleware.ts` name them
 * in prose to say they are deliberately NOT read — the regex ignores comments,
 * but an allowlist entry costs nothing and a false positive costs a build.
 */
const ALLOWED = new Set([
  'src/auth.ts',
  'src/lib/auth/guard.ts',
  'src/middleware.ts',
  'src/app/api/v1/_lib/context.ts',
]);

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

  it('is read nowhere else', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => FORBIDDEN.test(code(readFileSync(f, 'utf8'))));

    expect(offenders).toEqual([]);
  });
});
