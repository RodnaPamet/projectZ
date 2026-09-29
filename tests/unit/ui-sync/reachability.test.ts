/** @jest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { analyseReachability, globToRegExp } from '../../../scripts/ui-sync/reachability.mjs';
import { importSpecifiers, stripComments } from '../../../scripts/ui-sync/source.mjs';

/**
 * The import graph T28 deletes by and T29's reachability ratchet counts with.
 * A false "unreachable" deletes a live file; a false "reachable" keeps dead
 * code for ever. Every import form the graph follows is pinned here, on a
 * fixture tree, both ways.
 */

const FIXTURE: Record<string, string> = {
  'src/app/page.tsx': [
    "import { A } from '@/components/ui';",
    "import type { T } from '@/components/ui/types';",
    "import * as Everything from '@/components/ui/star-only';",
    "import '@/components/ui/side-effect';",
    "const Lazy = dynamic(() => import('@/components/ui/lazy'));",
    "// import { Commented } from '@/components/ui/commented';",
    'export default function Page() { return [A, Everything, Lazy] as unknown as T; }',
  ].join('\n'),
  'src/middleware.ts': "import { mw } from '@/components/ui/mw';\nexport const m = mw;",
  'scripts/tool.ts':
    "import { tool } from '../src/components/ui/script-only';\nexport default tool;",
  'src/components/ui/index.ts': [
    "export { A } from './a';",
    "export { B } from './b';",
    "export * from './c';",
    "export * as ns from './ns';",
  ].join('\n'),
  'src/components/ui/a.tsx': "import { helper } from './helper';\nexport const A = helper;",
  'src/components/ui/helper.ts': 'export const helper = 1;',
  'src/components/ui/b.tsx': 'export const B = 2;',
  'src/components/ui/c.ts': 'export const C = 3;',
  'src/components/ui/ns.ts': 'export const N = 4;',
  'src/components/ui/types.ts': 'export type T = string;',
  'src/components/ui/star-only.ts': 'export const S = 5;',
  'src/components/ui/side-effect.ts': 'globalThis.x = 1;',
  'src/components/ui/lazy.tsx': 'export default 1;',
  'src/components/ui/commented.ts': 'export const Commented = 1;',
  'src/components/ui/mw.ts': 'export const mw = 1;',
  'src/components/ui/script-only.ts': 'export const tool = 1;',
  'src/components/ui/guard-only.ts': 'export const g = 1;',
  'src/components/ui/__tests__/a.test.tsx': "import { A } from '../a';\ntest('a', () => A);",
  'tests/guardrails/uses.test.ts': "import { g } from '../../src/components/ui/guard-only';\n",
};

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ui-sync-reach-'));
  for (const [path, text] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${text}\n`);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('analyseReachability', () => {
  it('follows named imports through a barrel to the file that defines them, and no further', () => {
    const r = analyseReachability({ root });
    // index.ts is live (it is imported), and so is a.tsx behind it. b, c and ns
    // are re-exported by the same barrel but nobody asks for them.
    expect(r.unreachable).toEqual(
      expect.arrayContaining([
        'src/components/ui/b.tsx',
        'src/components/ui/c.ts',
        'src/components/ui/ns.ts',
      ]),
    );
    expect(r.unreachable).not.toContain('src/components/ui/a.tsx');
    expect(r.unreachable).not.toContain('src/components/ui/helper.ts');
    expect(r.unreachable).not.toContain('src/components/ui/index.ts');
  });

  it('counts type-only, namespace, side-effect and dynamic imports', () => {
    const { unreachable } = analyseReachability({ root });
    for (const live of ['types.ts', 'star-only.ts', 'side-effect.ts', 'lazy.tsx']) {
      expect(unreachable).not.toContain(`src/components/ui/${live}`);
    }
  });

  it('roots at src/app/**, src/*.ts and scripts/**, and nothing in a comment', () => {
    const { unreachable } = analyseReachability({ root });
    expect(unreachable).not.toContain('src/components/ui/mw.ts');
    expect(unreachable).not.toContain('src/components/ui/script-only.ts');
    expect(unreachable).toContain('src/components/ui/commented.ts');
  });

  it('adds roots on request: a module only a guardrail imports stays', () => {
    expect(analyseReachability({ root }).unreachable).toContain('src/components/ui/guard-only.ts');
    const withGuards = analyseReachability({
      root,
      roots: ['src/app/**', 'src/*.ts', 'scripts/**', 'tests/guardrails/**'],
    });
    expect(withGuards.unreachable).not.toContain('src/components/ui/guard-only.ts');
  });

  it('reports the scope only, without colocated tests, with per-directory counts', () => {
    const r = analyseReachability({ root });
    expect(r.files).toBe(
      Object.keys(FIXTURE).filter(
        (f) => f.startsWith('src/components/') && !f.includes('__tests__'),
      ).length,
    );
    expect(r.unreachable.some((f: string) => f.includes('__tests__'))).toBe(false);
    expect(r.byDirectory).toEqual([
      {
        directory: 'src/components/ui',
        files: r.files,
        reachable: r.reachable,
        unreachable: r.unreachable.length,
      },
    ]);
    expect(r.unresolvedSymbols).toEqual([]);
  });
});

describe('the pieces it is built from', () => {
  it('globToRegExp: ** spans directories, * does not', () => {
    expect(globToRegExp('src/app/**').test('src/app/(app)/me/page.tsx')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/middleware.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/lib/cn.ts')).toBe(false);
    expect(globToRegExp('tests/guardrails/**').test('tests/guardrails/a.test.ts')).toBe(true);
  });

  it('stripComments keeps strings that contain // and drops real comments', () => {
    const out = stripComments("const u = 'https://x.bg'; // gone\n/* gone\n too */ const k = 1;");
    expect(out).toContain("'https://x.bg'");
    expect(out).not.toContain('gone');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('importSpecifiers finds every import form', () => {
    expect(
      importSpecifiers(
        [
          "import a from './a';",
          "import type { B } from '@/b';",
          "export { c } from './c';",
          "export * from './d';",
          "import './e.css';",
          "const f = await import('./f');",
          "const g = require('g');",
          "// import h from './h';",
        ].join('\n'),
      ).sort(),
    ).toEqual(['./a', './c', './d', './e.css', './f', '@/b', 'g']);
  });
});
