import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import { aliasTarget } from '../../scripts/ui-sync/inflect-package.mjs';

/**
 * WHAT A REQUEST CAN REACH: the files Next.js runs, and everything they import.
 *
 * Shared by the guardrails that ask "is this live?": the use-case one
 * (usecase-reachability.test.ts, where the reasoning for each entry point is)
 * and the account-deletion one (account-deletion-new-rows.test.ts), which
 * asks whether anything live writes a table.
 *
 * MODULE granularity: a file is reached when anything reached imports it,
 * whichever export that import wanted.
 */

/** Entry points: anything Next.js will actually run. */
export const ENTRY_POINTS = [
  ...globSync('src/app/**/route.ts').map((f) => f.toString()),
  ...globSync('src/app/**/page.tsx').map((f) => f.toString()),
  // A layout renders on every request beneath it, as surely as its pages do:
  // the club admin layout reads the club's public venue for its way out (#362).
  ...globSync('src/app/**/layout.tsx').map((f) => f.toString()),
  // ═══ SERVER ACTIONS ARE ENTRY POINTS TOO ═══
  //
  // A `'use server'` module compiles to POST endpoints the client can call
  // directly — as reachable as any route.ts, and reachable WITHOUT the page
  // that rendered the form. Omitting them would report a use case wired to an
  // action as unreachable scaffolding, which is the opposite of true and would
  // push the next author to add it to NOT_WIRED_YET and stop thinking.
  //
  // Matched on the directive rather than a filename, because there is no
  // convention yet and `actions.ts` is only where the first ones happened to
  // land.
  ...globSync('src/app/**/*.ts')
    .map((f) => f.toString())
    .filter((f) => /^\s*['"]use server['"]/.test(readFileSync(f, 'utf8'))),
  'src/middleware.ts',
].filter((f) => existsSync(f));

/**
 * `@/lib/x` and `@inflect/ui/lib/x` → `src/lib/x` (tsconfig.json maps both);
 * `./sibling` → resolved against the importer.
 */
function resolveImport(spec: string, fromFile: string): string | null {
  let base = aliasTarget(spec);
  if (base === null && spec.startsWith('.')) base = normalize(join(dirname(fromFile), spec));
  if (base === null) return null; // a package, not ours

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function reachableFromEntryPoints(): Set<string> {
  const seen = new Set<string>();
  const queue = [...ENTRY_POINTS];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const src = readFileSync(file, 'utf8');
    // `from '...'`, `import('...')`, `require('...')`
    for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImport(m[1]!, file);
      if (target && !seen.has(target)) queue.push(target);
    }
  }

  return seen;
}
