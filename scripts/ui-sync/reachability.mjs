/**
 * WHICH FILES DOES THE PRODUCT ACTUALLY RUN?
 *
 *   node scripts/ui-sync/reachability.mjs [--roots <glob>]... [--scope <prefix>]... [--root <dir>]
 *
 * A symbol-level import graph, rooted at src/app/**, src/*.ts and scripts/**
 * (--roots adds more; T28 adds tests/guardrails/** so a lib module a guardrail
 * imports is kept). Prints JSON: the files under --scope (default
 * src/components/) that nothing reachable imports, and per-directory counts.
 *
 * ═══ WHY SYMBOL-LEVEL ═══
 *
 * A file-level walk through a barrel keeps everything the barrel re-exports:
 * `import { Button } from '@/components/ui'` would mark all 470 files behind
 * ui's index as live. Here a named import follows only the export it names,
 * through any number of `export … from` hops, to the file that defines it. A
 * file used only for its types still counts as reachable, because deleting it
 * breaks the typecheck.
 *
 * Regex-based, not the TypeScript resolver: `@/`, `@inflect/ui/` (tsconfig maps
 * both onto src/) and relative specifiers, the common import and export forms,
 * dynamic import() and require(). The unit
 * tests pin each form; unresolvedSymbols lists any named import it could not
 * follow.
 *
 * The unreachable files split in two (T29). `heldByBarrel`: a used barrel
 * re-exports them, so they are compiled and deleting one breaks the build
 * until the barrel drops the line. `orphaned`: nothing built imports them at
 * all, so they can simply go. tests/guardrails/component-reachability.test.ts
 * keeps `orphaned` at its allow-list and `heldByBarrel` from growing.
 *
 * Importable too: tests/guardrails can call analyseReachability() directly.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';

import { UsageError, parseCli, run } from './cli.mjs';
import { aliasTarget } from './inflect-package.mjs';
import { stripComments } from './source.mjs';

export const DEFAULT_ROOTS = ['src/app/**', 'src/*.ts', 'scripts/**'];
export const DEFAULT_SCOPE = ['src/components/'];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  'playwright-report',
  'test-results',
]);
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
];
const ID = '[A-Za-z_$][\\w$]*';
// Two patterns, not one alternation: `a|b$` anchors only its second branch,
// which reads as a bug (CodeQL js/regex/missing-regexp-anchor) even when the
// first branch is meant to match anywhere in the path.
const TEST_DIR = /(?:^|\/)__tests__\//;
const TEST_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const isTestFile = (f) => TEST_DIR.test(f) || TEST_SUFFIX.test(f);

/** `src/app/**`, `src/*.ts`: `**` spans directories, `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(root, dir, acc) {
  for (const name of readdirSync(join(root, dir))) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, acc);
    else if (CODE.test(name)) acc.push(rel);
  }
  return acc;
}

function parseNamed(list, allType) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let typeOnly = allType;
      if (/^type\s+/.test(s)) {
        typeOnly = true;
        s = s.replace(/^type\s+/, '');
      }
      const m = new RegExp(`^(${ID}|default)(?:\\s+as\\s+(${ID}|default))?$`).exec(s);
      return m ? { name: m[1], alias: m[2] ?? m[1], typeOnly } : null;
    })
    .filter(Boolean);
}

/** What one module imports and exports, from its source text. */
function parseModule(file, src, resolveSpec) {
  const mod = { imports: [], reexports: [], locals: new Set(), whole: [] };
  let m;

  const importRe = /\bimport\s+(type\s+)?([^'";]*?)\s*\bfrom\s*(['"])([^'"\n]+)\3/g;
  while ((m = importRe.exec(src))) {
    const target = resolveSpec(file, m[4]);
    if (!target) continue;
    const allType = Boolean(m[1]);
    const clause = m[2].trim();
    const syms = [];
    if (new RegExp(`\\*\\s*as\\s+${ID}`).test(clause)) syms.push({ name: '*', typeOnly: allType });
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) syms.push(...parseNamed(braces[1], allType));
    const def = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/\*\s*as\s+[\w$]+/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (def && new RegExp(`^${ID}$`).test(def)) syms.push({ name: 'default', typeOnly: allType });
    mod.imports.push({ target, syms });
  }

  for (const re of [
    /\bimport\s*(['"])([^'"\n]+)\1/g, // side effect: `import './x.css'`
    /\b(?:import|require)\s*\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g, // dynamic
  ]) {
    while ((m = re.exec(src))) {
      const target = resolveSpec(file, m[2]);
      if (target) mod.whole.push(target);
    }
  }

  const reexportRe =
    /\bexport\s+(type\s+)?(\*(?:\s*as\s+([\w$]+))?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\4/g;
  while ((m = reexportRe.exec(src))) {
    const target = resolveSpec(file, m[5]);
    const allType = Boolean(m[1]);
    if (m[2].startsWith('*')) {
      if (m[3]) {
        mod.locals.add(m[3]);
        mod.reexports.push({ kind: 'namespace', as: m[3], target, typeOnly: allType });
      } else mod.reexports.push({ kind: 'star', target, typeOnly: allType });
    } else {
      for (const s of parseNamed(m[2].slice(1, -1), allType)) {
        mod.reexports.push({
          kind: 'named',
          name: s.name,
          as: s.alias,
          target,
          typeOnly: s.typeOnly,
        });
      }
    }
  }

  for (const re of [
    new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`, 'g'),
    new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:const|let|var)\\s+(${ID})`, 'g'),
    new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`, 'g'),
    new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:type|interface|enum|namespace)\\s+(${ID})`, 'g'),
  ]) {
    while ((m = re.exec(src))) mod.locals.add(m[1]);
  }
  const destructured = /\bexport\s+(?:const|let|var)\s+\{([^}]*)\}\s*=/g;
  while ((m = destructured.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (name) mod.locals.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(src)) mod.locals.add('default');
  const list = /\bexport\s+(type\s+)?\{([^}]*)\}(?!\s*from)/g;
  while ((m = list.exec(src)))
    for (const s of parseNamed(m[2], Boolean(m[1]))) mod.locals.add(s.alias);
  return mod;
}

/**
 * The reachability of every code file under `root`.
 *
 * roots  globs of entry files (every export of an entry counts as used)
 * scope  path prefixes the report covers
 */
export function analyseReachability({
  root = process.cwd(),
  roots = DEFAULT_ROOTS,
  scope = DEFAULT_SCOPE,
} = {}) {
  const files = walk(root, '', []).sort();
  const fileSet = new Set(files);

  const resolveSpec = (from, spec) => {
    // `@/` and `@inflect/ui/` (a vendored file's import of a module inflect
    // moved into its package) are both src/.
    let base = aliasTarget(spec);
    if (base === null && spec.startsWith('.'))
      base = posix.normalize(posix.join(posix.dirname(from), spec));
    if (base === null) return null;
    for (const s of SUFFIXES) if (fileSet.has(base + s)) return base + s;
    const js = /^(.*)\.(?:js|jsx|mjs)$/.exec(base); // TS source imported by its emitted name
    if (js) for (const s of ['.ts', '.tsx']) if (fileSet.has(js[1] + s)) return js[1] + s;
    return null;
  };

  const mods = new Map(
    files.map((f) => [
      f,
      parseModule(f, stripComments(readFileSync(join(root, f), 'utf8')), resolveSpec),
    ]),
  );

  const everything = new Map();
  /** A module plus everything it re-exports: what `import *` or a side-effect import pulls in. */
  const allOf = (file, seen = new Set()) => {
    if (seen.has(file)) return new Set();
    seen.add(file);
    const out = new Set([file]);
    for (const r of mods.get(file)?.reexports ?? [])
      if (r.target) for (const x of allOf(r.target, seen)) out.add(x);
    return out;
  };
  const allFiles = (file) => {
    if (!everything.has(file)) everything.set(file, allOf(file));
    return everything.get(file);
  };

  const exportsCache = new Map();
  const exportsName = (file, name, seen = new Set()) => {
    const key = `${file}::${name}`;
    if (exportsCache.has(key)) return exportsCache.get(key);
    if (seen.has(file)) return false;
    seen.add(file);
    const mod = mods.get(file);
    if (!mod) return false;
    const yes =
      mod.locals.has(name) ||
      mod.reexports.some((r) => r.kind === 'named' && r.as === name) ||
      mod.reexports.some((r) => r.kind === 'star' && r.target && exportsName(r.target, name, seen));
    exportsCache.set(key, yes);
    return yes;
  };

  const unresolvedSymbols = new Set();
  const providerCache = new Map();
  /** The files along the path from `file`'s export `name` to its definition. */
  const providers = (file, name, depth = 0) => {
    const key = `${file}::${name}`;
    if (providerCache.has(key)) return providerCache.get(key);
    const out = new Set([file]);
    providerCache.set(key, out); // cycle guard
    const mod = mods.get(file);
    if (!mod || depth > 30) return out;
    if (mod.locals.has(name)) {
      for (const r of mod.reexports) {
        if (r.kind === 'namespace' && r.as === name && r.target)
          for (const x of allFiles(r.target)) out.add(x);
      }
      return out;
    }
    let found = false;
    for (const r of mod.reexports) {
      if (r.kind === 'named' && r.as === name && r.target) {
        found = true;
        for (const x of providers(r.target, r.name, depth + 1)) out.add(x);
      }
    }
    if (!found) {
      for (const r of mod.reexports) {
        if (r.kind === 'star' && r.target && exportsName(r.target, name)) {
          found = true;
          for (const x of providers(r.target, name, depth + 1)) out.add(x);
        }
      }
    }
    if (!found) unresolvedSymbols.add(`${file} :: ${name}`);
    return out;
  };

  const rootRes = roots.map(globToRegExp);
  const seeds = files.filter((f) => rootRes.some((re) => re.test(f)));
  const used = new Set();
  const stack = [];
  const markUsed = (f) => {
    if (!used.has(f)) {
      used.add(f);
      stack.push(f);
    }
  };
  for (const s of seeds) for (const x of allFiles(s)) markUsed(x);
  while (stack.length) {
    const mod = mods.get(stack.pop());
    if (!mod) continue;
    for (const imp of mod.imports) {
      for (const s of imp.syms) {
        for (const p of s.name === '*' ? allFiles(imp.target) : providers(imp.target, s.name))
          markUsed(p);
      }
    }
    for (const t of mod.whole) for (const p of allFiles(t)) markUsed(p);
  }

  // The FILE-level closure of what is used: every module a used module imports
  // or re-exports, whole, whatever it names. A file in here that the symbol walk
  // did not reach is "held": nothing runs it, but deleting it breaks the build,
  // because a used barrel re-exports it (`export * from './x'`) or a held file
  // imports it. T28 kept 326 such files behind the vendored ui/hooks and
  // ui/icons barrels, which are byte-identical copies and cannot drop a line.
  const held = new Set(used);
  const pending = [...used];
  while (pending.length) {
    const mod = mods.get(pending.pop());
    if (!mod) continue;
    const next = [
      ...mod.imports.map((i) => i.target),
      ...mod.reexports.map((r) => r.target),
      ...mod.whole,
    ].filter(Boolean);
    for (const t of next)
      for (const f of allFiles(t))
        if (!held.has(f)) {
          held.add(f);
          pending.push(f);
        }
  }

  // A colocated test is never reachable from the product and is not a component:
  // it goes when the file it tests goes.
  const scoped = files.filter((f) => scope.some((p) => f.startsWith(p)) && !isTestFile(f));
  const byDirectory = new Map();
  for (const f of scoped) {
    const dir = posix.dirname(f);
    if (!byDirectory.has(dir))
      byDirectory.set(dir, { directory: dir, files: 0, reachable: 0, unreachable: 0 });
    const row = byDirectory.get(dir);
    row.files++;
    if (used.has(f)) row.reachable++;
    else row.unreachable++;
  }

  return {
    roots,
    scope,
    seeds: seeds.length,
    files: scoped.length,
    reachable: scoped.filter((f) => used.has(f)).length,
    unreachable: scoped.filter((f) => !used.has(f)),
    /** Unreachable, but a used barrel (or another held file) still pulls it into the build. */
    heldByBarrel: scoped.filter((f) => !used.has(f) && held.has(f)),
    /** Unreachable and imported by nothing that is built: deleting it breaks nothing. */
    orphaned: scoped.filter((f) => !held.has(f)),
    byDirectory: [...byDirectory.values()].sort((a, b) => (a.directory < b.directory ? -1 : 1)),
    unresolvedSymbols: [...unresolvedSymbols].sort(),
  };
}

const USAGE = `Usage: node scripts/ui-sync/reachability.mjs [--roots <glob>]... [--scope <prefix>]...
                                           [--root <dir>] [--out <file>]

  --roots <glob>    another entry point, on top of ${DEFAULT_ROOTS.join(', ')}
  --scope <prefix>  report files under this prefix (default: ${DEFAULT_SCOPE.join(', ')})
  --root <dir>      playerz checkout (default: the current directory)
  --out <file>      write the JSON there instead of stdout`;

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), {
    values: ['root', 'out'],
    multiple: ['roots', 'scope'],
  });
  if (positionals.length) throw new UsageError(`Unexpected argument ${positionals[0]}`);
  const root = resolve(flags.root ?? process.cwd());
  if (!existsSync(join(root, 'src'))) throw new UsageError(`${root} has no src/ directory.`);
  const result = analyseReachability({
    root,
    roots: [...DEFAULT_ROOTS, ...(flags.roots ?? [])],
    scope: flags.scope ?? DEFAULT_SCOPE,
  });
  const json = `${JSON.stringify({ root: relative(process.cwd(), root) || '.', ...result }, null, 2)}\n`;
  if (flags.out) {
    writeFileSync(flags.out, json);
    console.error(
      `${result.unreachable.length} of ${result.files} scoped files unreachable; wrote ${flags.out}`,
    );
  } else process.stdout.write(json);
}

// Run only as a CLI: the guardrails import analyseReachability() from here.
if (process.argv[1] && /reachability\.mjs$/.test(process.argv[1])) run(main, USAGE);
