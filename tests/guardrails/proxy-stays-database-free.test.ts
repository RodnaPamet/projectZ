import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import { aliasTarget } from '../../scripts/ui-sync/inflect-package.mjs';

/**
 * THE PROXY READS NO DATABASE (#270).
 *
 * ═══ A LIMIT THAT BECAME A RULE ═══
 *
 * As `middleware.ts` the proxy ran on the Edge runtime, which cannot load
 * Prisma. Nobody had to decide that it reads no database: it could not.
 * Next 16 renamed the convention to `proxy.ts` and runs it on Node, where it
 * can import anything. The premise the code was written on is now only a
 * habit, and a habit is one helpful import away from ending.
 *
 * It must hold, for two reasons:
 *
 *   - #250 moved every membership and permission decision into
 *     `contextFromRequest`, so the database answers them once, in one place.
 *     A proxy that looked a membership up would be a second place deciding
 *     it, which is how the claim-based bugs of #250 happened.
 *   - it runs before EVERY request the matcher lets through, the public pages
 *     and their assets' neighbours included. A query here is a query on every
 *     one of them.
 *
 * So the import graph is walked from `src/proxy.ts`, through value imports
 * only (`import type` loads nothing), and none of it may be the database
 * client, a driver, Redis, or the modules that wrap them.
 */

const ENTRY = 'src/proxy.ts';

/** Packages that are a database or a connection to one. */
const FORBIDDEN_PACKAGES = [/^@prisma\//, /^pg$/, /^pg-/, /^ioredis$/, /^redis$/, /^@upstash\//];

/** Our own modules that open one. */
const FORBIDDEN_FILES = [/^src\/lib\/db\//, /^src\/lib\/redis/, /^src\/app-layer\//];

function resolveImport(spec: string, fromFile: string): string | null {
  let base = aliasTarget(spec);
  if (base === null && spec.startsWith('.')) base = normalize(join(dirname(fromFile), spec));
  if (base === null) return null; // a package, not ours
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every `from '…'` / `import('…')` / `require('…')` that loads code at run time. */
function valueImports(src: string): string[] {
  const out: string[] = [];
  // Static imports and re-exports, skipping `import type` and `export type`.
  const stat = /^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = stat.exec(src)) !== null) if (!m[2]) out.push(m[3]!);
  // Side-effect imports: `import './x'`.
  for (const s of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(s[1]!);
  // Dynamic ones.
  for (const d of src.matchAll(/(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(d[1]!);
  return out;
}

interface Walk {
  files: Set<string>;
  /** Each forbidden thing found, with the chain of imports that reached it. */
  found: string[];
}

function walk(): Walk {
  const files = new Set<string>();
  const found: string[] = [];
  const queue: Array<{ file: string; via: string[] }> = [{ file: ENTRY, via: [] }];

  while (queue.length > 0) {
    const { file, via } = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const chain = [...via, file];

    if (FORBIDDEN_FILES.some((re) => re.test(file))) {
      found.push(chain.join('\n    → '));
      continue;
    }

    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      const target = resolveImport(spec, file);
      if (target) {
        queue.push({ file: target, via: chain });
      } else if (FORBIDDEN_PACKAGES.some((re) => re.test(spec))) {
        found.push([...chain, spec].join('\n    → '));
      }
    }
  }
  return { files, found };
}

describe('the proxy stays database-free (#270)', () => {
  const result = walk();

  it('the walk started at the proxy and followed its imports', () => {
    // A resolver that finds nothing would make the check below pass on an
    // empty graph.
    expect(existsSync(ENTRY)).toBe(true);
    expect(existsSync('src/middleware.ts')).toBe(false);
    expect(result.files.has('src/lib/auth/guard.ts')).toBe(true);
    expect(result.files.has('src/lib/auth/owed-step.ts')).toBe(true);
    expect(result.files.size).toBeGreaterThan(5);
  });

  it('nothing it imports is the database, a driver, Redis or the app layer', () => {
    if (result.found.length > 0) {
      throw new Error(
        `src/proxy.ts now reaches the database:\n\n` +
          result.found.map((c) => `    ${c}`).join('\n\n') +
          `\n\nThe proxy runs before every request and decides from the token alone (#250,\n` +
          `#270). Whatever needed the database belongs in the route: contextFromRequest\n` +
          `for the API, resolveTenantPageContext or requireTenantAction for pages and\n` +
          `actions. If only a TYPE was wanted, write \`import type\`.`,
      );
    }
  });

  it('the detectors see the shapes they are meant to', () => {
    const src = [
      "import { PrismaClient } from '@prisma/client';",
      "import type { Role } from '@prisma/client';",
      "export { x } from './y';",
      "export type { T } from './types';",
      "import './side-effect';",
      "const m = await import('@/lib/db/prisma');",
    ].join('\n');
    expect(valueImports(src).sort()).toEqual(
      ['./side-effect', './y', '@/lib/db/prisma', '@prisma/client'].sort(),
    );
    expect(FORBIDDEN_PACKAGES.some((re) => re.test('@prisma/client'))).toBe(true);
    expect(FORBIDDEN_FILES.some((re) => re.test('src/lib/db/rls-middleware.ts'))).toBe(true);
    expect(FORBIDDEN_FILES.some((re) => re.test('src/lib/auth/guard.ts'))).toBe(false);
  });

  it('it is a proxy by Next 16’s convention: the named export, and no runtime option', () => {
    const src = readFileSync(ENTRY, 'utf8');
    expect(src).toMatch(/^export async function proxy\(/m);
    expect(src).not.toMatch(/^export (async )?function middleware\b/m);
    // Setting `runtime` in a proxy file throws at build time (proxy.md, "Runtime").
    expect(src).not.toMatch(/^export const runtime\b/m);
    expect(src).toMatch(/^export const config = \{/m);
  });
});
