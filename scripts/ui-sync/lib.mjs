/**
 * Shared machinery for the ui-sync CLIs: reading inflect through git, and the
 * normalisation that makes the two repos comparable.
 *
 * ═══ WHY NORMALISE ═══
 *
 * inflect is formatted with double quotes, playerz with single quotes and the
 * Tailwind class-sort plugin. The 2026-07 port reformatted every file on the way
 * in, so a raw diff of the two trees reports 10,084 changed lines where only
 * 4,132 changed in meaning (measured on 44048af vs inflect 8d2feb4e3). Every
 * comparison here runs both sides through THIS repo's prettier and .prettierrc
 * first, so formatting never shows up as drift, and copy.mjs writes exactly
 * that output, so a vendored file is prettier(inflect@sha) byte for byte.
 *
 * Only the CLIs import this file. The guardrail cannot (see manifest.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsageError } from './cli.mjs';
import { importSpecifiers } from './source.mjs';

export { UsageError, parseCli, run } from './cli.mjs';

/** The playerz checkout this script lives in. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function git(dir, args, { input, encoding = 'utf8' } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], {
    input,
    encoding,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}

/**
 * Where inflect is checked out: $INFLECT_DIR, else `inflect-compliance` beside
 * the MAIN playerz checkout. `--git-common-dir` is what makes the default work
 * from a worktree, which lives inside the main checkout rather than beside it;
 * on the owner's machine it resolves to /Users/user/git/inflect-compliance.
 * CI clones the public RodnaPamet/inflect-compliance and sets INFLECT_DIR.
 */
export function inflectDir() {
  if (process.env.INFLECT_DIR) return resolve(process.env.INFLECT_DIR);
  const r = git(REPO_ROOT, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.status === 0 ? r.stdout.trim() : join(REPO_ROOT, '.git');
  return join(dirname(dirname(common)), 'inflect-compliance');
}

/** A revision's full commit SHA, or a UsageError that says how to get it. */
export function resolveRev(dir, rev, what) {
  if (!existsSync(dir)) {
    throw new UsageError(
      `No ${what} checkout at ${dir}. Clone it there, or point INFLECT_DIR at a clone.`,
    );
  }
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (r.status !== 0) {
    throw new UsageError(
      `${what} has no commit "${rev}" in ${dir}. Fetch first: git -C ${dir} fetch origin`,
    );
  }
  return r.stdout.trim();
}

/** One inflect file at one revision, or null when the path does not exist there. */
export function readInflect(ref, path, dir = inflectDir()) {
  const r = git(dir, ['show', `${ref}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

/**
 * Many `<rev>:<path>` blobs in one `git cat-file --batch`. status.mjs reads two
 * per row: for the 484 rows, 968 blobs took 0.12 s this way and 9.7 s as one
 * `git show` each (measured on a 10-core Mac, byte-identical output).
 * Returns spec → UTF-8 text, or null for a path absent at that revision.
 */
export function readBlobs(dir, specs) {
  const unique = [...new Set(specs)];
  const out = new Map();
  if (unique.length === 0) return out;
  const r = git(dir, ['cat-file', '--batch'], { input: `${unique.join('\n')}\n`, encoding: null });
  if (r.status !== 0) throw new Error(`git cat-file failed in ${dir}: ${r.stderr}`);
  const buf = r.stdout;
  let at = 0;
  for (const spec of unique) {
    const eol = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, eol).toString('utf8');
    at = eol + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) {
      out.set(spec, null); // "<spec> missing", or a directory
      continue;
    }
    const size = Number(m[2]);
    out.set(spec, m[1] === 'blob' ? buf.subarray(at, at + size).toString('utf8') : null);
    at += size + 1; // content, then a newline
  }
  return out;
}

/** Every file under `paths` at `rev` (all of them when `paths` is empty). */
export function listFiles(dir, rev, paths = []) {
  const r = git(dir, ['ls-tree', '-r', '--name-only', '--full-tree', rev, '--', ...paths]);
  if (r.status !== 0) throw new Error(`git ls-tree failed in ${dir}: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

let prettierSetup;

/** This repo's prettier, with .prettierrc's plugins loaded from this repo. */
async function loadPrettier() {
  prettierSetup ??= (async () => {
    const prettier = await import('prettier');
    // editorconfig: true is what the prettier CLI (and so the pre-commit hook)
    // does by default; the API defaults to false.
    const config =
      (await prettier.resolveConfig(join(REPO_ROOT, 'package.json'), { editorconfig: true })) ?? {};
    // A plugin named in .prettierrc is a string. Load it from HERE, so the
    // result does not depend on the directory the script was started from.
    const plugins = await Promise.all(
      (config.plugins ?? []).map((p) => (typeof p === 'string' ? import(p) : p)),
    );
    return { prettier, config: { ...config, plugins } };
  })();
  return prettierSetup;
}

const normalised = new Map();

/**
 * prettier(text) under this repo's .prettierrc, as it would format a file at
 * `path` in this repo. That filepath picks the parser and lets the Tailwind
 * plugin sort classes exactly as `prettier --write` does here. Formatted until
 * stable (in practice once), because the pre-commit hook formats again.
 */
export async function normalise(text, path) {
  const key = `${path}\0${text}`;
  const hit = normalised.get(key);
  if (hit !== undefined) return hit;
  const { prettier, config } = await loadPrettier();
  const options = { ...config, filepath: join(REPO_ROOT, path) };
  let out = text.replace(/\r\n?/g, '\n');
  for (let pass = 0; pass < 3; pass++) {
    const next = await prettier.format(out, options);
    if (next === out) break;
    out = next;
  }
  normalised.set(key, out);
  return out;
}

/**
 * The form two files are compared in: normalised, trailing whitespace dropped,
 * blank lines dropped. Prettier keeps a single blank line wherever it finds
 * one, so a blank line added or removed on one side would otherwise count as
 * drift. (Measured on 44048af vs 8d2feb4e3: every one of the 430 files that
 * compare equal is also byte-for-byte prettier(inflect), so this hides nothing
 * a copy would change today.)
 */
export async function comparable(text, path) {
  if (text == null) return null;
  let out;
  try {
    out = await normalise(text, path);
  } catch {
    out = text.replace(/\r\n?/g, '\n'); // unparseable: compare it raw rather than not at all
  }
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '')
    .join('\n');
}

/** Lines added and removed between two texts (Myers, insertions and deletions only). */
export function diffCounts(aText, bText) {
  const a = aText == null ? [] : aText.split('\n');
  const b = bText == null ? [] : bText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  let d = max;
  outer: for (let step = 0; step <= max; step++) {
    for (let k = -step; k <= step; k += 2) {
      let x =
        k === -step || (k !== step && v[max + k - 1] < v[max + k + 1])
          ? v[max + k + 1]
          : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        d = step;
        break outer;
      }
    }
  }
  return { added: (d + (m - n)) / 2, removed: (d - (m - n)) / 2 };
}

const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

/**
 * A read-only view of a playerz tree: the working tree under `root`, or the
 * commit `rev` of the repo at `root`.
 */
export function playerzTree(root, rev = null) {
  if (rev) {
    const sha = resolveRev(root, rev, 'playerz');
    const files = new Set(listFiles(root, sha));
    const pkg = readBlobs(root, [`${sha}:package.json`]).get(`${sha}:package.json`);
    return {
      rev: sha,
      exists: (p) => files.has(p),
      readMany: (paths) => {
        const blobs = readBlobs(
          root,
          paths.map((p) => `${sha}:${p}`),
        );
        return new Map(paths.map((p) => [p, blobs.get(`${sha}:${p}`) ?? null]));
      },
      packages: packageNames(pkg),
    };
  }
  const exists = (p) => {
    const f = join(root, p);
    return existsSync(f) && statSync(f).isFile();
  };
  const pkgFile = join(root, 'package.json');
  return {
    rev: null,
    exists,
    readMany: (paths) =>
      new Map(paths.map((p) => [p, exists(p) ? readFileSync(join(root, p), 'utf8') : null])),
    packages: packageNames(existsSync(pkgFile) ? readFileSync(pkgFile, 'utf8') : null),
  };
}

function packageNames(json) {
  if (!json) return new Set();
  const pkg = JSON.parse(json);
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

/**
 * The imports of `text` (a file that would live at `fromPath`) that `tree`
 * cannot satisfy: a missing module under src/ (via the `@/` alias or a relative
 * path), or a package that is not in package.json.
 */
export function unresolvedImports(text, fromPath, tree) {
  const missing = [];
  for (const spec of importSpecifiers(text)) {
    let base = null;
    if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith('.'))
      base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    if (base !== null) {
      if (!RESOLVE_SUFFIXES.some((s) => tree.exists(base + s))) missing.push(spec);
      continue;
    }
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (spec.startsWith('node:') || builtinModules.includes(name)) continue;
    if (!tree.packages.has(name)) missing.push(`${spec} (package)`);
  }
  return missing;
}
