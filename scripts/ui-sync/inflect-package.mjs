/**
 * WHERE INFLECT KEEPS A FILE: src/, OR THE @inflect/ui PACKAGE (inflect #3046).
 *
 * inflect is moving its shared UI out of src/ into the npm workspace package
 * @inflect/ui at packages/ui, one directory per PR: cn.ts first (step 2a), the
 * 333 icons (2b), then 21 of the 24 ui/hooks (3a), with table/, the flat
 * primitives, layout/ and src/lib/hooks to follow. The package mirrors src/:
 * src/lib/cn.ts is now packages/ui/src/lib/cn.ts, and its package.json exports
 * `@inflect/ui/<p>` as packages/ui/src/<p>.
 *
 * playerz keeps every copy where it was, at src/<p>, and a byte-identical copy
 * still resolves there:
 *
 *   - a file that moved imports the files beside it by relative path
 *     (`../../../lib/cn`), and the same relative path from src/<p> reaches
 *     playerz's copy, because the package has the same layout as src/;
 *   - a file still in inflect's src/ imports a moved one as `@inflect/ui/<p>`,
 *     and tsconfig.json and jest.config.mjs resolve that onto src/<p>, as they
 *     do `@/<p>`. So does every hand-written resolver here (aliasTarget).
 *
 * The same file therefore has two inflect paths, src/<p> before its move and
 * packages/ui/src/<p> after, and the ui-sync tools look for a row's file at
 * both (inflectLocations), so a move is never reported as GONE.
 *
 * Pure (no imports), so the guardrails can load it under jest.
 */

/** Where the package's source sits in inflect. */
export const PACKAGE_SRC = 'packages/ui/src/';

/** The import-specifier prefix inflect's own files use for the package. */
export const PACKAGE_SPECIFIER = '@inflect/ui/';

/** The playerz path of an inflect path: packages/ui/src/<p> is src/<p>; any other path is itself. */
export function playerzPath(inflectPath) {
  return inflectPath.startsWith(PACKAGE_SRC)
    ? `src/${inflectPath.slice(PACKAGE_SRC.length)}`
    : inflectPath;
}

/**
 * Every inflect path the file at `inflectPath` can have, the package first:
 * src/<p> and packages/ui/src/<p> are one file before and after its move. The
 * package comes first because the move goes that way: if inflect ever keeps
 * both, the file in src/ is the shim that re-exports the package's. A path
 * outside src/ has only itself.
 */
export function inflectLocations(inflectPath) {
  const path = playerzPath(inflectPath);
  if (!path.startsWith('src/')) return [inflectPath];
  return [`${PACKAGE_SRC}${path.slice('src/'.length)}`, path];
}

/**
 * The repo path an aliased import specifier names, before extension and index
 * resolution: `@/<p>` and `@inflect/ui/<p>` are both src/<p>. Null for a
 * relative specifier or a package. The bare `@inflect/ui` is the package's
 * public index, which playerz does not vendor, so it stays a package.
 */
export function aliasTarget(spec) {
  if (spec.startsWith('@/')) return `src/${spec.slice('@/'.length)}`;
  if (spec.startsWith(PACKAGE_SPECIFIER)) return `src/${spec.slice(PACKAGE_SPECIFIER.length)}`;
  return null;
}
