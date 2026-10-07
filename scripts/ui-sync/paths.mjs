/**
 * WHICH INFLECT PATHS PLAYERZ MUST ACCOUNT FOR.
 *
 * docs/ui-sync/inflect-paths.txt lists every inflect path under the synced
 * component directories at one inflect commit, plus the src/lib modules playerz
 * vendors. The guardrail reads it in CI, where no inflect clone exists, and
 * demands a manifest row for every playerz file at one of those paths. That is
 * what stops a file being copied from inflect by hand, outside copy.mjs: it
 * lands at an inflect path, and nothing would otherwise know it is a copy.
 *
 * Each directory is listed in both of inflect's layouts, src/<p> and
 * packages/ui/src/<p> (inflect-package.mjs), because inflect #3046 is moving
 * them into the @inflect/ui package. playerz keeps packages/ui/src/<p> at
 * src/<p>, so that is the file the guardrail looks for.
 *
 *   node scripts/ui-sync/paths.mjs [--ref <rev>]
 *       report playerz files at inflect paths that have no row
 *   ... --write
 *       rewrite inflect-paths.txt at that commit
 *   ... --add-pending [--base <sha>] [src/lib/extra.ts ...]
 *       give each of them a 'pending' row (baseSha: the 2026-07 port base)
 *   ... --repoint
 *       point each row's inflectPath, in the manifest and in available.json,
 *       at where inflect keeps the file at that commit: after inflect moves
 *       files into packages/ui, and nothing else about the row changes
 *
 * Extra positional paths add src/lib modules to the list; the lib modules that
 * already have rows are always listed. This is how the manifest was first built:
 *
 *   node scripts/ui-sync/paths.mjs --ref origin/main --write --add-pending \
 *     src/lib/cn.ts src/lib/theme-constants.ts \
 *     src/lib/hooks/use-keyboard-shortcut.tsx src/lib/hooks/keyboard-shortcut-internals.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PACKAGE_SRC, inflectLocations, playerzPath } from './inflect-package.mjs';
import {
  REPO_ROOT,
  UsageError,
  git,
  inflectDir,
  listFiles,
  parseCli,
  playerzTree,
  resolveRev,
  run,
} from './lib.mjs';
import {
  AVAILABLE_FILE,
  INFLECT_PATHS_FILE,
  MANIFEST_NAMES,
  PORT_BASE,
  SYNCED_DIRS,
  formatInflectPaths,
  manifestFile,
  manifestFor,
  readAllRows,
  readAvailable,
  readManifest,
  sha256,
  writeAvailable,
  writeManifest,
} from './manifest.mjs';

const USAGE = `Usage: node scripts/ui-sync/paths.mjs [--ref <rev>] [--root <dir>] [--write]
                                    [--add-pending [--base <sha>]] [--repoint] [src/lib/path ...]`;

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), {
    values: ['ref', 'root', 'base'],
    switches: ['write', 'add-pending', 'repoint'],
  });
  const root = resolve(flags.root ?? REPO_ROOT);
  const dir = inflectDir();
  const sha = resolveRev(dir, flags.ref ?? 'origin/main', 'inflect');
  const short = sha.slice(0, 9);

  // Every file inflect has at sha, and where one file of it is: the first of
  // its locations that exists (the package first), or null.
  const inflectFiles = new Set(listFiles(dir, sha));
  const locate = (p) => inflectLocations(p).find((at) => inflectFiles.has(at)) ?? null;

  const extra = positionals.map((p) => p.replace(/^\.\//, ''));
  for (const p of extra) {
    if (!playerzPath(p).startsWith('src/lib/'))
      throw new UsageError(`${p}: only src/lib modules are added by name`);
    if (!locate(p)) throw new UsageError(`${p} is not in inflect at ${short}`);
  }
  const synced = SYNCED_DIRS.flatMap(inflectLocations).map((d) => `${d}/`);
  // A lib row whose file inflect no longer has stays listed as it was: the
  // playerz file is still a copy.
  const libPaths = [...readManifest(root, 'lib').map((r) => r.inflectPath), ...extra].map(
    (p) => locate(p) ?? p,
  );
  const paths = [
    ...new Set([
      ...[...inflectFiles].filter((f) => synced.some((d) => f.startsWith(d))),
      ...libPaths,
    ]),
  ].sort();

  // The inflect path each playerz path comes from (the package's, if both).
  const source = new Map();
  for (const p of paths) {
    const target = playerzPath(p);
    if (!source.has(target) || p.startsWith(PACKAGE_SRC)) source.set(target, p);
  }
  const tree = playerzTree(root);
  const rowed = new Set(readAllRows(root).map((r) => r.path));
  const targets = [...source.keys()].sort();
  const unrowed = targets.filter((p) => tree.exists(p) && !rowed.has(p));

  const packaged = paths.filter((p) => p.startsWith(PACKAGE_SRC)).length;
  console.log(
    `inflect ${short}: ${paths.length} paths (${packaged} in ${PACKAGE_SRC}); playerz has ` +
      `${targets.filter(tree.exists).length} of them, ${unrowed.length} without a manifest row`,
  );
  for (const p of unrowed) console.log(`  no row: ${p}`);

  if (flags['add-pending'] && unrowed.length) {
    const base = flags.base ?? PORT_BASE;
    resolveRev(dir, base, 'inflect');
    const byManifest = new Map();
    for (const p of unrowed) {
      const name = manifestFor(p);
      if (!name) throw new UsageError(`${p} is outside every manifest`);
      if (!byManifest.has(name)) byManifest.set(name, readManifest(root, name));
      byManifest.get(name).push({
        path: p,
        inflectPath: source.get(p),
        baseSha: base,
        sha: null,
        status: 'pending',
        sha256: sha256(readFileSync(join(root, p))),
      });
    }
    for (const [name, rows] of byManifest) writeManifest(root, name, rows);
    console.log(`added ${unrowed.length} pending rows (baseSha ${base})`);
  }

  if (flags.repoint) {
    // Only inflectPath changes. baseSha and sha still name the commits the
    // row was synced from; the tools read those at whichever location the
    // file had then.
    const repointed = (rows) => {
      let n = 0;
      const out = rows.map((row) => {
        const at = locate(row.inflectPath);
        if (!at || at === row.inflectPath) return row;
        n++;
        return { ...row, inflectPath: at };
      });
      return { out, n };
    };
    let total = 0;
    for (const name of MANIFEST_NAMES) {
      const { out, n } = repointed(readManifest(root, name));
      if (n === 0) continue;
      writeManifest(root, name, out);
      console.log(`re-pointed ${n} row(s) in ${manifestFile(name)}`);
      total += n;
    }
    const available = repointed(readAvailable(root));
    if (available.n > 0) {
      writeAvailable(root, available.out);
      console.log(`re-pointed ${available.n} row(s) in ${AVAILABLE_FILE}`);
      total += available.n;
    }
    console.log(`re-pointed ${total} row(s) at inflect ${short}`);
  }

  if (flags.write) {
    const date = git(dir, ['show', '-s', '--format=%cs', sha]).stdout.trim();
    writeFileSync(join(root, INFLECT_PATHS_FILE), formatInflectPaths({ sha, date, paths }));
    console.log(`wrote ${INFLECT_PATHS_FILE}`);
  }
}

run(main, USAGE);
